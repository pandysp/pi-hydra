#!/usr/bin/env node
/**
 * Severity consensus protocol (CONSENSUS-SPEC.md). Three participants — sol,
 * opus and the analyst — label every pooled issue on the two axes that v4
 * established as reliably elicitable (`blocking` 90.5%, `anyHarm` 95.2%) and
 * deliberate until they agree. No human sign-off: Andreas delegated the set to
 * "you and the two judges".
 *
 * The analyst is a real participant, not a simulated one. The script therefore
 * runs ONE ROUND PER INVOCATION and stops: round 1 needs the analyst's labels
 * recorded BEFORE any judge call (that file is the independence proof), and
 * each deliberation round needs the analyst's own revisions, written by the
 * analyst after reading the same anonymised packets the judges see. A script
 * that generated the analyst's position with a third model call would be
 * measuring three judges and calling one of them an author.
 *
 * Anonymisation: participants see each other only as "another reviewer", so a
 * judge cannot defer to a model it believes is stronger. That is what makes
 * C2 (evidence vs capitulation) readable.
 *
 * Usage:
 *   node experiments/severity-consensus.mjs --round 1 --state <dir>
 *   node experiments/severity-consensus.mjs --round 2 --state <dir>   # after
 *                                    writing analyst-round2.json in <dir>
 * Zero producer spend; both judges are subscription-billed.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { codeContext } from "./severity-pool-probe.mjs";

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CORRECTION =
	"Your output did not match the required JSON schema or item count. Preserve every judgment and return only the corrected JSON object.";

const JUDGES = {
	sol: { transport: "pi", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
	opus: { transport: "claude-cli", model: "opus", reasoning: "high" },
};

export const PARTICIPANTS = ["sol", "opus", "analyst"];

/** The two axes v4 established as reliable. The 4-level scale is not used. */
export const AXES = ["blocking", "anyHarm"];

export function agreed(positions, id) {
	const held = PARTICIPANTS.map((p) => positions[p]?.[id]).filter(Boolean);
	if (held.length !== PARTICIPANTS.length) return false;
	return AXES.every((axis) => held.every((h) => h[axis] === held[0][axis]));
}

export function majority(positions, id, axis) {
	const votes = PARTICIPANTS.map((p) => positions[p]?.[id]?.[axis]).filter((v) => typeof v === "boolean");
	const yes = votes.filter(Boolean).length;
	return yes * 2 > votes.length;
}

/**
 * A position change is EVIDENCE-driven when its stated reason points at the
 * artefact (code, docs, the statement itself) and AUTHORITY-driven when it
 * points at the other reviewers. Capitulation invalidates a consensus, so the
 * classifier errs toward calling a mixed reason authority-driven: the failure
 * we care about is a converged set built from deference.
 */
export function classifyRevision(reason) {
	const text = String(reason ?? "").toLowerCase();
	const authority = /(another reviewer|other reviewer|the others?\b|majority|consensus|defer|persuaded by|agree with (the|another)|on reflection.*reviewer)/.test(text);
	const evidence = /(code|line|function|src\/|docs\/|\.js|claimedby|leaseexpires|attempts|store\.|await|test|statement says|the statement|reachab|null|snippet)/.test(text);
	if (authority) return "authority";
	if (evidence) return "evidence";
	return "unclassified";
}

function sha(text) {
	return createHash("sha256").update(text).digest("hex");
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function piTransport(spec) {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("./model-catalog.mjs"),
	]);
	const model = resolveModel(spec.provider, spec.model);
	if (!model) throw new Error(`judge model unavailable: ${spec.model}`);
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[spec.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${spec.provider} login; run pi and log in first`);
	}
	const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	return {
		async ask(prompt, prior) {
			const messages = prior ? [user(prompt), prior.raw, user(CORRECTION)] : [user(prompt)];
			const result = await streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages, tools: [] },
				{ apiKey: credential.access, reasoning: spec.reasoning, maxTokens: 4000 },
			).result();
			return { text: textOf(result), error: result.errorMessage ?? null, raw: result };
		},
	};
}

function claudeCliTransport(spec, timeoutMs) {
	return {
		async ask(prompt, prior) {
			const text = prior ? `${prompt}\n\nYour prior response was structurally invalid:\n${prior.text}\n\n${CORRECTION}` : prompt;
			return new Promise((resolve) => {
				const child = spawn("claude", [
					"-p", "--safe-mode", "--no-session-persistence", "--disable-slash-commands",
					"--tools", "", "--model", spec.model, "--effort", spec.reasoning,
					"--system-prompt", SYSTEM_PROMPT, text,
				]);
				let stdout = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.on("error", (error) => { clearTimeout(timer); resolve({ text: stdout, error: error.message, raw: stdout }); });
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					if (signal === "SIGKILL") return resolve({ text: stdout, error: `claude killed after ${timeoutMs}ms`, raw: stdout });
					resolve({ text: stdout, error: code === 0 ? null : `claude exited ${code}`, raw: stdout });
				});
				child.stdin.end();
			});
		},
	};
}

export function parseLabels(text, expectedIds) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) throw new Error("no JSON object in judge output");
	const parsed = JSON.parse(match[0]);
	const items = parsed.judgments ?? parsed.items ?? parsed;
	const out = {};
	for (const id of expectedIds) {
		const item = Array.isArray(items) ? items.find((x) => x.id === id) : items[id];
		if (!item) throw new Error(`judge omitted ${id}`);
		if (typeof item.blocking !== "boolean" || typeof item.anyHarm !== "boolean") {
			throw new Error(`${id}: blocking and anyHarm must be booleans`);
		}
		out[id] = { blocking: item.blocking, anyHarm: item.anyHarm, reason: String(item.reason ?? "").trim() };
	}
	return out;
}

const RUBRIC = `Two independent yes/no questions per issue. Do NOT grade on a scale.

blocking — TRUE only if you would hold a release for it: it causes data loss,
silent incorrect results, permanent resource capture, a security hole, or
duplicate execution of real work. Cost, noise, missing tests, documentation
defects and reporting inaccuracies are NOT blocking however annoying.

anyHarm — TRUE if the issue is a genuine defect evidenced by the code or docs
shown, of any size. FALSE if it is not real, not evidenced, or purely a matter
of taste.

Judge the issue as stated against the source below. Answer for every issue.`;

/**
 * The code the judges must reason against is the SESSION's code, not the
 * seeded task files. Round 1 of the first run showed judges the seeded
 * `src/` only; 13 of 21 issues are about `stats`, `deadLetter`, `logSummary`
 * or the docs — all written by the DRIVER during the trajectory and absent
 * from the seed — so the judges correctly answered "not evidenced" and the
 * run measured my prompt, not their judgment. `codeContext` (shared with the
 * v2 probe, which got this right) renders start-of-session AND end-of-session
 * state from the recorded `file-state` rows.
 */
function sourceBlock(code) {
	return code;
}

function roundOnePrompt(issues, code) {
	return `${RUBRIC}

SOURCE UNDER REVIEW
${sourceBlock(code)}

ISSUES
${issues.map((i) => `[${i.id}] ${i.statement}`).join("\n")}

Return ONLY:
{"judgments":[{"id":"<id>","blocking":true|false,"anyHarm":true|false,"reason":"<one sentence>"}]}`;
}

function deliberationPrompt(issues, code, others) {
	return `${RUBRIC}

SOURCE UNDER REVIEW
${sourceBlock(code)}

You previously judged these issues. Other reviewers reached different
conclusions. Their positions and reasons are below, anonymised. Revise your
position if their reasoning changes your reading of the SOURCE; hold it if it
does not. State plainly WHY, citing the source rather than the other reviewer.
Holding a well-reasoned position is a valid outcome.

${issues.map((i) => {
	const lines = others[i.id].map((o, n) => `   reviewer ${n + 1}: blocking=${o.blocking} anyHarm=${o.anyHarm} — ${o.reason}`).join("\n");
	return `[${i.id}] ${i.statement}\n   YOUR PRIOR: blocking=${i.mine.blocking} anyHarm=${i.mine.anyHarm} — ${i.mine.reason}\n${lines}`;
}).join("\n\n")}

Return ONLY:
{"judgments":[{"id":"<id>","blocking":true|false,"anyHarm":true|false,"reason":"<one sentence: what in the source decides it>"}]}`;
}

async function askJudge(name, prompt, expectedIds, timeoutMs) {
	const spec = JUDGES[name];
	const transport = spec.transport === "pi" ? await piTransport(spec) : claudeCliTransport(spec, timeoutMs);
	let attempt = await transport.ask(prompt, null);
	try {
		return parseLabels(attempt.text, expectedIds);
	} catch (error) {
		if (attempt.error) throw new Error(`${name}: ${attempt.error}`);
		const retry = await transport.ask(prompt, attempt);
		return parseLabels(retry.text, expectedIds);
	}
}

async function main() {
	const args = process.argv.slice(2);
	const round = Number.parseInt(argOf(args, "--round", "1"), 10);
	const stateDir = argOf(args, "--state", "");
	const poolPath = argOf(args, "--pool", "experiments/artifacts/2026-08-01-severity-probe-v2/out.json.gz");
	const timeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "600000"), 10);
	const batchSize = Number.parseInt(argOf(args, "--batch-size", "7"), 10);
	if (!stateDir) throw new Error("--state <dir> is required");
	if (!Number.isInteger(round) || round < 1) throw new Error("--round must be >= 1");

	const pool = JSON.parse(gunzipSync(readFileSync(poolPath)).toString());
	const rowsPath = argOf(args, "--rows", `${process.env.HOME}/scratch/2026-08-01-hydra-c2-trajectory/rows.jsonl`);
	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const code = codeContext(rows);
	const candidates = pool.candidates.map((c) => ({ id: c.id, statement: c.statement }));
	const ids = candidates.map((c) => c.id);

	const statePath = `${stateDir}/state.json`;
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { rounds: {} };

	const analystPath = `${stateDir}/analyst-round${round}.json`;
	if (!existsSync(analystPath)) {
		throw new Error(`${analystPath} missing — the analyst is a participant and must record positions for round ${round} BEFORE the judges are called`);
	}
	const analyst = JSON.parse(readFileSync(analystPath, "utf8")).labels;

	let positions;
	if (round === 1) {
		const batches = [];
		for (let i = 0; i < candidates.length; i += batchSize) batches.push(candidates.slice(i, i + batchSize));
		const collect = async (name) => {
			const merged = {};
			for (const batch of batches) {
				const got = await askJudge(name, roundOnePrompt(batch, code), batch.map((b) => b.id), timeoutMs);
				Object.assign(merged, got);
				process.stderr.write(`  ${name}: ${Object.keys(merged).length}/${candidates.length}\n`);
			}
			return merged;
		};
		positions = { sol: await collect("sol"), opus: await collect("opus"), analyst };
	} else {
		const prior = state.rounds[round - 1];
		if (!prior) throw new Error(`round ${round - 1} has not run`);
		const open = ids.filter((id) => !agreed(prior.positions, id));
		if (open.length === 0) {
			process.stderr.write("all issues converged; nothing to deliberate\n");
			return;
		}
		process.stderr.write(`deliberating ${open.length} open issue(s): ${open.join(", ")}\n`);
		const collect = async (name) => {
			const merged = { ...prior.positions[name] };
			const batches = [];
			const openCandidates = candidates.filter((c) => open.includes(c.id));
			for (let i = 0; i < openCandidates.length; i += batchSize) batches.push(openCandidates.slice(i, i + batchSize));
			for (const batch of batches) {
				const issues = batch.map((c) => ({ ...c, mine: prior.positions[name][c.id] }));
				const others = Object.fromEntries(batch.map((c) => [
					c.id,
					PARTICIPANTS.filter((p) => p !== name).map((p) => prior.positions[p][c.id]),
				]));
				const got = await askJudge(name, deliberationPrompt(issues, code, others), batch.map((b) => b.id), timeoutMs);
				Object.assign(merged, got);
			}
			return merged;
		};
		positions = { sol: await collect("sol"), opus: await collect("opus"), analyst };
	}

	const converged = ids.filter((id) => agreed(positions, id));
	state.rounds[round] = { positions, converged, open: ids.filter((id) => !converged.includes(id)) };
	state.poolPath = poolPath;
	state.ids = ids;
	writeFileSync(statePath, JSON.stringify(state, null, 1));

	process.stdout.write(`round ${round}: ${converged.length}/${ids.length} converged\n`);
	if (state.rounds[round].open.length > 0) {
		process.stdout.write(`open: ${state.rounds[round].open.join(", ")}\n`);
		const packets = {};
		for (const id of state.rounds[round].open) {
			packets[id] = {
				statement: candidates.find((c) => c.id === id).statement,
				others: Object.fromEntries(PARTICIPANTS.map((p) => [p, positions[p][id]])),
			};
		}
		writeFileSync(`${stateDir}/open-round${round}.json`, JSON.stringify(packets, null, 1));
		process.stdout.write(`packets for the analyst: ${stateDir}/open-round${round}.json\n`);
	}
	process.stdout.write(`state hash: ${sha(JSON.stringify(state.rounds[round].positions)).slice(0, 16)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
