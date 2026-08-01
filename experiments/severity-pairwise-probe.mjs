#!/usr/bin/env node
/**
 * Severity v3 — reference review + PAIRWISE ranking. A PROBE, not a shipped
 * metric: its job is to find out whether severity is reliably elicitable from
 * LLM judges when asked as a comparison rather than as an absolute grade.
 *
 * Pre-registered in `SEVERITY-V3-SPEC.md`. v1 asked for absolute grades and got
 * 41.7% exact agreement; v2 decomposes the grade; v3 changes the ELICITATION,
 * because absolute scales are the unreliable instrument and the target Andreas
 * described was always a ranking ("of the top issues, does the reviewer find
 * them?").
 *
 * Three stages:
 *   1. REFERENCE REVIEW — one strong model reads the whole trajectory and lists
 *      every defect it finds. This is what removes v1's structural flaw, where
 *      the pool was seeded only from what the arms happened to say and a defect
 *      nobody found could never enter the reference set.
 *   2. PAIRWISE — judges compare two issues at a time, blind to arms, with
 *      order and orientation randomised per pair. Bradley-Terry turns the
 *      comparisons into a ranking.
 *   3. MEMBERSHIP + SCORE — a multi-select judge reads each delivered message
 *      against the whole pool, so one message naming two defects credits both
 *      (v1's clustering folded exactly such a message into a single issue and
 *      made MAIN's strongest finding invisible). Never keyword matching: see
 *      commit 96eff06, where a keyword matcher produced three published numbers
 *      that all had to be retracted.
 *
 * Zero producer spend: the trajectory rows and payloads already exist. Judges
 * are subscription-billed.
 *
 * Usage:
 *   node experiments/severity-pairwise-probe.mjs \
 *     --rows ~/scratch/2026-08-01-hydra-c2-trajectory/rows.jsonl \
 *     --out  ~/scratch/2026-08-01-hydra-severity-v3
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CLI_TIMEOUT_MS = 600_000;

export const sha16 = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------
// Deterministic RNG. Randomised pair order and orientation must be reproducible
// or the raw comparisons in the results doc cannot be re-derived.
// ---------------------------------------------------------------------------

export function rng(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 4294967296;
	};
}

export function shuffled(items, random) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Transports. Same recipes as delivery-context-golden-judge.mjs; restated here
// because that module parses argv and runs its matrix on import.
// ---------------------------------------------------------------------------

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function piTransport({ provider = "openai-codex", model = "gpt-5.6-sol", reasoning = "high" } = {}) {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("./model-catalog.mjs"),
	]);
	const resolved = resolveModel(provider, model);
	if (!resolved) throw new Error(`judge model unavailable: ${model}`);
	const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
	return {
		name: "sol",
		model: resolved.id,
		async ask(prompt) {
			const result = await streamSimple(
				resolved,
				{ systemPrompt: SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], tools: [] },
				{ apiKey: credential.access, reasoning, maxTokens: 4000 },
			).result();
			return { text: textOf(result), error: result.errorMessage ?? null };
		},
	};
}

function claudeCliTransport({ name = "opus", model = "opus", reasoning = "high" } = {}) {
	return {
		name,
		model,
		async ask(prompt) {
			return new Promise((resolve) => {
				const child = spawn("claude", [
					"-p", "--safe-mode", "--no-session-persistence", "--disable-slash-commands",
					"--tools", "", "--model", model, "--effort", reasoning,
					"--system-prompt", SYSTEM_PROMPT, prompt,
				]);
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), CLI_TIMEOUT_MS);
				const settle = (error) => { clearTimeout(timer); resolve({ text: stdout, error }); };
				child.stdout.on("data", (c) => { stdout += c; });
				child.stderr.on("data", (c) => { stderr += c; });
				child.on("error", (e) => settle(e.message));
				child.on("close", (code, signal) => {
					if (signal === "SIGKILL") return settle(`claude killed after ${CLI_TIMEOUT_MS}ms`);
					settle(code === 0 ? null : stderr.trim() || `claude exited ${code}`);
				});
				child.stdin.end();
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Trajectory reading.
// ---------------------------------------------------------------------------

export function deliveredMessages(rows) {
	return rows
		.filter((row) => row.kind === "observation" && row.valid !== false)
		.filter((row) => {
			const text = String(row.responseText ?? "");
			if (!text.trim()) return false;
			if (/DELIVERY:\s*none\s*$/im.test(text) && !/DELIVERY:\s*(print|queue|steer|interrupt)/i.test(text)) return false;
			try {
				const parsed = JSON.parse(text);
				if (parsed?.action === "noop") return false;
			} catch { /* footer arms are not JSON */ }
			return true;
		})
		.map((row) => ({
			arm: row.arm,
			pointIndex: row.pointIndex,
			delivery: row.delivery ?? null,
			text: messageOf(row),
		}))
		.sort((a, b) => a.pointIndex - b.pointIndex || a.arm.localeCompare(b.arm));
}

function messageOf(row) {
	const text = String(row.responseText ?? "");
	try {
		const parsed = JSON.parse(text);
		if (parsed && typeof parsed.message === "string") return parsed.message;
	} catch { /* not JSON */ }
	return text.replace(/\s*DELIVERY:\s*\w+\s*$/i, "").trim();
}

/**
 * A captured Anthropic payload carries `tool_result.content` as a bare string
 * on this driver's shape, not the block array the SDK types suggest. Both are
 * handled: the string form is what the recorded payloads actually contain, and
 * getting this wrong silently empties the transcript the reference reviewer
 * reads, which would make the whole reference stage vacuous.
 */
export function toolResultText(block) {
	const content = block?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.filter((b) => b?.type === "text").map((b) => b.text).join("");
	return "";
}

/** The transcript the last observer saw: the richest view of the code in the run. */
export function renderTranscript(payload) {
	const parts = [];
	for (const message of payload.messages ?? []) {
		for (const block of message.content ?? []) {
			if (block.type === "text") parts.push(`[${message.role}] ${block.text}`);
			else if (block.type === "tool_use") parts.push(`[${message.role} calls ${block.name}] ${JSON.stringify(block.input).slice(0, 400)}`);
			else if (block.type === "tool_result") parts.push(`[tool result] ${toolResultText(block)}`);
		}
	}
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Stage 1 — reference review.
// ---------------------------------------------------------------------------

export function referencePrompt(transcript) {
	return `Below is the complete transcript of a coding agent working on a job-scheduler codebase: the files it read, the edits it made, and the results it saw.

Write the ideal code review of the CODE VISIBLE IN THIS TRANSCRIPT. List every genuine defect you can find — correctness, concurrency, security, resource, data-integrity. One line per defect, each naming the function or file and the concrete failure it causes.

Rules:
- Only defects evidenced by material visible in the transcript. No speculation about code you cannot see.
- Do NOT rank or order by importance. List them as you find them.
- Do not include style preferences, naming, or missing tests unless the absence causes a concrete failure.

Return ONLY JSON:
{"issues":[{"id":"r01","where":"<function or file>","defect":"<one line: the flaw and the failure it causes>"}]}`;
}

export function parseIssues(text, prefix) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return null;
	let value;
	try { value = JSON.parse(match[0]); } catch { return null; }
	if (!Array.isArray(value?.issues)) return null;
	const out = [];
	for (const [index, item] of value.issues.entries()) {
		if (typeof item?.defect !== "string" || !item.defect.trim()) return null;
		out.push({ id: `${prefix}${String(index + 1).padStart(2, "0")}`, where: String(item.where ?? "").trim(), defect: item.defect.trim() });
	}
	return out;
}

// ---------------------------------------------------------------------------
// Stage 2 — pairwise comparison + Bradley-Terry.
// ---------------------------------------------------------------------------

export function allPairs(ids) {
	const pairs = [];
	for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
	return pairs;
}

/**
 * Round robin up to 12 issues, a sampled design above that (spec §Stage 2).
 * Round robin on 20 issues is 190 comparisons per judge, which is wall-clock
 * the probe does not need to spend. The sampled design keeps the comparison
 * graph CONNECTED — a Bradley-Terry fit over a disconnected graph produces
 * strengths that cannot be compared across components, which would look like a
 * ranking and mean nothing. A Hamiltonian cycle guarantees connectivity, then
 * random extra pairs give each issue roughly `degree` comparisons.
 */
export function comparisonDesign(ids, random, { roundRobinUpTo = 12, degree = 5 } = {}) {
	if (ids.length <= roundRobinUpTo) return allPairs(ids);
	const order = shuffled(ids, random);
	const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
	const chosen = new Map();
	for (let i = 0; i < order.length; i++) {
		const pair = [order[i], order[(i + 1) % order.length]];
		chosen.set(key(...pair), pair);
	}
	const pool = allPairs(ids).filter((pair) => !chosen.has(key(...pair)));
	const target = Math.min(allPairs(ids).length, Math.ceil((ids.length * degree) / 2));
	for (const pair of shuffled(pool, random)) {
		if (chosen.size >= target) break;
		chosen.set(key(...pair), pair);
	}
	return [...chosen.values()];
}

export function pairwisePrompt(batch, issueById) {
	const blocks = batch.map((pair, index) => {
		const a = issueById.get(pair.left);
		const b = issueById.get(pair.right);
		return `### Comparison c${String(index + 1).padStart(2, "0")}
A: ${a.defect}
B: ${b.defect}`;
	});
	return `You are comparing defects found in one job-scheduler codebase. The team's task was to document the scheduler's real behaviour and fix its retry accounting.

For each comparison, answer: which of these two would you rather a code reviewer had caught? Judge by how much harm the defect causes if it ships and how likely it is to bite in practice. Answer "equal" only when you genuinely cannot separate them.

${blocks.join("\n\n")}

Return ONLY JSON, one entry per comparison, in order:
{"comparisons":[{"id":"c01","reasoning":"<one sentence>","winner":"A"}]}
winner must be exactly "A", "B", or "equal".`;
}

export function parseComparisons(text, expectedCount) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return null;
	let value;
	try { value = JSON.parse(match[0]); } catch { return null; }
	const list = value?.comparisons;
	if (!Array.isArray(list) || list.length !== expectedCount) return null;
	for (const [index, item] of list.entries()) {
		if (item?.id !== `c${String(index + 1).padStart(2, "0")}`) return null;
		if (!["A", "B", "equal"].includes(item?.winner)) return null;
	}
	return list;
}

/**
 * Bradley-Terry by minorization-maximization. A tie counts as half a win each,
 * the standard treatment. Strengths are returned on a log scale, centred, so the
 * ranking is readable and scale-free.
 */
export function bradleyTerry(ids, comparisons, { iterations = 500 } = {}) {
	const wins = new Map(ids.map((id) => [id, 0]));
	const games = new Map();
	for (const { winner, loser, tie } of comparisons) {
		const key = (a, b) => `${a}|${b}`;
		games.set(key(winner, loser), (games.get(key(winner, loser)) ?? 0) + 1);
		games.set(key(loser, winner), (games.get(key(loser, winner)) ?? 0) + 1);
		if (tie) {
			wins.set(winner, wins.get(winner) + 0.5);
			wins.set(loser, wins.get(loser) + 0.5);
		} else {
			wins.set(winner, wins.get(winner) + 1);
		}
	}
	const strength = new Map(ids.map((id) => [id, 1]));
	for (let step = 0; step < iterations; step++) {
		for (const id of ids) {
			let denominator = 0;
			for (const other of ids) {
				if (other === id) continue;
				const n = games.get(`${id}|${other}`) ?? 0;
				if (n === 0) continue;
				denominator += n / (strength.get(id) + strength.get(other));
			}
			// +0.5 smoothing keeps an undefeated or winless issue finite.
			const next = denominator > 0 ? (wins.get(id) + 0.5) / (denominator + 0.5 / strength.get(id)) : strength.get(id);
			strength.set(id, Math.max(next, 1e-9));
		}
		const mean = Math.exp([...strength.values()].reduce((sum, v) => sum + Math.log(v), 0) / ids.length);
		for (const id of ids) strength.set(id, strength.get(id) / mean);
	}
	return ids
		.map((id) => ({ id, strength: strength.get(id), logStrength: Math.log(strength.get(id)), wins: wins.get(id) }))
		.sort((a, b) => b.strength - a.strength);
}

// ---------------------------------------------------------------------------
// Stage 3 — membership. Multi-select per message: one message may name several
// issues, which is exactly what v1's clustering destroyed.
// ---------------------------------------------------------------------------

export function membershipPrompt(messages, pool) {
	const catalogue = pool.map((issue) => `${issue.id}. ${issue.defect}`).join("\n");
	const blocks = messages.map((message, index) => `### Message m${String(index + 1).padStart(2, "0")}\n${message.text}`);
	return `Below is a catalogue of defects in a job-scheduler codebase, then some feedback messages a reviewer sent while the code was being written.

CATALOGUE:
${catalogue}

For each message, list every catalogue id the message IDENTIFIES — meaning the message describes that defect's mechanism or its concrete consequence, not merely mentioning the same function name. A message may identify several ids, or none.

${blocks.join("\n\n")}

Return ONLY JSON, one entry per message, in order:
{"messages":[{"id":"m01","reasoning":"<one sentence>","identifies":["r01"]}]}
Use an empty array when the message identifies nothing in the catalogue.`;
}

export function parseMembership(text, expectedCount, validIds) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) return null;
	let value;
	try { value = JSON.parse(match[0]); } catch { return null; }
	const list = value?.messages;
	if (!Array.isArray(list) || list.length !== expectedCount) return null;
	for (const [index, item] of list.entries()) {
		if (item?.id !== `m${String(index + 1).padStart(2, "0")}`) return null;
		if (!Array.isArray(item?.identifies)) return null;
		if (!item.identifies.every((id) => validIds.has(id))) return null;
	}
	return list;
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

export function agreementRate(a, b) {
	let agree = 0;
	for (let i = 0; i < a.length; i++) if (a[i] === b[i]) agree++;
	return { agree, total: a.length, rate: a.length === 0 ? null : agree / a.length };
}

export function rankWeightedCoverage(ranking, found) {
	// Weight by Bradley-Terry strength: the metric Andreas described, where
	// missing a top issue costs more than missing a minor one.
	let total = 0;
	let earned = 0;
	for (const item of ranking) {
		total += item.strength;
		if (found.has(item.id)) earned += item.strength;
	}
	return total === 0 ? null : earned / total;
}

export function topKHits(ranking, found, k) {
	const top = ranking.slice(0, k);
	return { hits: top.filter((item) => found.has(item.id)).length, of: top.length };
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

const chunk = (items, size) => {
	const out = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
};

async function askJson(transport, prompt, parse, { attempts = 3, label = "" } = {}) {
	let last = null;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		const response = await transport.ask(prompt);
		last = response;
		if (response.error) {
			console.error(`[${transport.name}] ${label} attempt ${attempt}: ${String(response.error).slice(0, 120)}`);
			continue;
		}
		const parsed = parse(response.text);
		if (parsed) return { parsed, raw: response.text };
		console.error(`[${transport.name}] ${label} attempt ${attempt}: unparseable (${response.text.slice(0, 100).replace(/\n/g, " ")})`);
	}
	throw new Error(`[${transport.name}] ${label}: no valid response after ${attempts} attempts (last: ${String(last?.text ?? last?.error).slice(0, 200)})`);
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "").replace(/^~/, process.env.HOME);
	const outDir = argOf(args, "--out", "").replace(/^~/, process.env.HOME);
	const seed = Number.parseInt(argOf(args, "--seed", "20260801"), 10);
	if (!rowsPath || !outDir) throw new Error("--rows and --out are required");
	mkdirSync(outDir, { recursive: true });

	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const messages = deliveredMessages(rows);
	const arms = [...new Set(messages.map((m) => m.arm))].sort();
	console.error(`[v3] ${messages.length} delivered messages across ${arms.length} arms (${arms.join(", ")})`);

	const observations = rows.filter((row) => row.kind === "observation" && row.capturedPayloadPath);
	const lastPayloadPath = observations.sort((a, b) => b.pointIndex - a.pointIndex)[0].capturedPayloadPath;
	const payload = JSON.parse(readFileSync(lastPayloadPath, "utf8"));
	const transcript = renderTranscript(payload);
	console.error(`[v3] transcript ${transcript.length} chars from ${lastPayloadPath}`);

	const sol = await piTransport();
	const opus = claudeCliTransport();

	// --- Stage 1: reference review -----------------------------------------
	console.error("[v3] stage 1: reference review (opus xhigh)");
	const referenceJudge = claudeCliTransport({ name: "reference", model: "opus", reasoning: "xhigh" });
	const reference = await askJson(
		referenceJudge,
		`${referencePrompt(transcript)}\n\nTRANSCRIPT:\n${transcript}`,
		(text) => parseIssues(text, "r"),
		{ label: "reference" },
	);
	console.error(`[v3] reference found ${reference.parsed.length} issues`);

	const planted = TRAJECTORY_TASKS.find((task) => task.id === "scheduler").defects;
	const pool = [
		...reference.parsed.map((issue) => ({ ...issue, provenance: "reference" })),
		...planted.map((defect, index) => ({
			id: `p${String(index + 1).padStart(2, "0")}`,
			where: defect.file,
			defect: defect.target,
			provenance: "planted",
			plantedId: defect.id,
		})),
	];
	const issueById = new Map(pool.map((issue) => [issue.id, issue]));
	const poolIds = pool.map((issue) => issue.id);
	console.error(`[v3] pool: ${pool.length} issues (${reference.parsed.length} reference + ${planted.length} planted)`);

	// --- Stage 2: pairwise --------------------------------------------------
	const random = rng(seed);
	const design = comparisonDesign(poolIds, random);
	const pairs = shuffled(design, random).map(([a, b]) => (random() < 0.5 ? { left: a, right: b } : { left: b, right: a }));
	console.error(
		`[v3] stage 2: ${pairs.length} pairwise comparisons x 2 judges (${poolIds.length <= 12 ? "round robin" : "sampled connected design"})`,
	);
	const batches = chunk(pairs, 6);
	const verdicts = { sol: [], opus: [] };
	for (const [index, batch] of batches.entries()) {
		for (const judge of [sol, opus]) {
			const { parsed } = await askJson(judge, pairwisePrompt(batch, issueById), (text) => parseComparisons(text, batch.length), {
				label: `pairwise ${index + 1}/${batches.length}`,
			});
			for (const [k, item] of parsed.entries()) {
				verdicts[judge.name].push({ ...batch[k], winner: item.winner, reasoning: item.reasoning });
			}
		}
		console.error(`[v3]   batch ${index + 1}/${batches.length} done`);
	}

	// --- Stage 3: membership ------------------------------------------------
	console.error("[v3] stage 3: membership (multi-select, both judges)");
	const messageBatches = chunk(messages, 5);
	const membership = { sol: [], opus: [] };
	const validIds = new Set(poolIds);
	for (const [index, batch] of messageBatches.entries()) {
		for (const judge of [sol, opus]) {
			const { parsed } = await askJson(judge, membershipPrompt(batch, pool), (text) => parseMembership(text, batch.length, validIds), {
				label: `membership ${index + 1}/${messageBatches.length}`,
			});
			for (const [k, item] of parsed.entries()) {
				membership[judge.name].push({ ...batch[k], identifies: item.identifies, reasoning: item.reasoning });
			}
		}
		console.error(`[v3]   messages ${index + 1}/${messageBatches.length} done`);
	}

	writeFileSync(join(outDir, "raw.json"), JSON.stringify({ pool, reference: reference.raw, verdicts, membership, seed }, null, 2));
	console.error(`[v3] wrote ${join(outDir, "raw.json")}`);
	console.error("[v3] DONE — analyse with severity-pairwise-report.mjs");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
