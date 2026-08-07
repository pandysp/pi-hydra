#!/usr/bin/env node
/**
 * SEVERITY-POOLING PROBE — NOT A SHIPPED METRIC.
 *
 * Pre-registered in `SEVERITY-PROBE-SPEC.md` (734cf72). Its job is to answer
 * P1: do two independent judges agree on severity? If they do not, the design
 * dies here and the probe has succeeded.
 *
 * The idea under test is IR-standard pooled relevance judgment: take every
 * finding every arm delivered on one trajectory, dedupe into distinct issues,
 * judge each issue ONCE for reality and severity, then score every arm by
 * severity-weighted recall over the pooled set. Extra real findings become
 * recall rather than bonus points, so spraying is not rewarded.
 *
 * Blindness, both directions (spec §Rules):
 *  - judges never see the arm that produced a message;
 *  - the severity judge never sees how many arms raised an issue, and reads a
 *    NEUTRAL canonical statement rather than any arm's wording, so phrasing
 *    quality cannot leak into a severity label.
 *
 * The two transports are RE-STATED here rather than imported: the judge script
 * parses argv and runs its matrix on import (`delivery-context-golden-judge.mjs`
 * :15-33). Same recipe, cited at the site — the house precedent set by
 * `trajectory-cost-ab.mjs:31-33`.
 *
 * Zero producer spend: judges only, both subscription-billed.
 *
 * Usage:
 *   node experiments/severity-pool-probe.mjs --rows rows.jsonl --output out.json
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CORRECTION =
	"Your output did not match the required JSON schema or case count. Preserve every judgment and return only the corrected JSON object.";

/** The pre-registered 4-level anchored scale. Weights are the spec's. */
export const SEVERITY_WEIGHTS = Object.freeze({
	blocking: 9,
	serious: 3,
	minor: 1,
	"not-an-issue": 0,
});

export const SEVERITY_ANCHORS = `blocking — data loss, a security hole, corrupted state, or something that breaks production.
serious — wrong behaviour or a silent failure that will bite in normal operation.
minor — redundancy, a missing test on a low-risk path, style, or a cosmetic problem.
not-an-issue — not a real defect, unsupported by the visible code, or already correct.`;

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

/**
 * A delivered observation is one that routed a message to somebody. `none` and
 * `noop` rows carry no claim, and invalid rows were dropped by the runner's own
 * assertions, so neither can enter the pool.
 */
export function poolMessages(rows) {
	const delivered = rows
		.filter((row) => row.kind === "observation" && row.valid !== false)
		.filter((row) => row.delivery && row.delivery !== "none")
		.sort((a, b) => a.arm.localeCompare(b.arm) || a.pointIndex - b.pointIndex);
	return delivered.map((row, index) => ({
		id: `m${String(index + 1).padStart(2, "0")}`,
		arm: row.arm,
		pointIndex: row.pointIndex,
		delivery: row.delivery,
		text: messageTextOf(row),
	}));
}

/**
 * The claim as the recipient would read it. A footer arm's response is the
 * finding with the DELIVERY line stripped; MAIN's is the JSON `message` field.
 * Read from `responseText` (raw) rather than any derived field.
 */
export function messageTextOf(row) {
	const raw = String(row.responseText ?? "").trim();
	if (/DELIVERY:\s*\w+\s*$/i.test(raw)) return raw.replace(/\s*DELIVERY:\s*\w+\s*$/i, "").trim();
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed?.message === "string") return parsed.message.trim();
	} catch {
		/* not JSON: fall through to the raw text */
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Code context: what the judge reads to decide "is this real"
// ---------------------------------------------------------------------------

/**
 * Both ends of the trajectory. A claim is judged against the code as it stood
 * when the trajectory began (where the planted defects live) AND as it ended
 * (so a defect the driver repaired is visible as repaired). Giving only one end
 * would make either the early or the late claims unjudgeable.
 */
export function codeContext(rows) {
	const states = rows.filter((row) => row.kind === "file-state").sort((a, b) => a.pointIndex - b.pointIndex);
	if (states.length === 0) throw new Error("no file-state rows: cannot judge claims against code");
	const first = states[0];
	const last = states[states.length - 1];
	const render = (files) =>
		Object.keys(files)
			.sort()
			.map((path) => `----- ${path}\n${files[path]}`)
			.join("\n");
	return `THE CODE AT THE START OF THE SESSION (this is the state the review began from):\n\n${render(first.files)}\n\nTHE CODE AT THE END OF THE SESSION (after the agent's edits):\n\n${render(last.files)}`;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

/** Dedupe. Messages carry anonymous ids only — no arm, no point, no ordering hint. */
export function clusterPrompt(messages) {
	const rendered = messages.map((item) => `${item.id}: ${item.text}`).join("\n\n");
	return `Several code reviewers each wrote short review notes about the same coding session. Different reviewers often describe THE SAME underlying defect in different words, and one note sometimes raises more than one distinct defect.

Group the notes by the UNDERLYING DEFECT they are about.

Rules:
- Two notes belong to the same group only if they describe the same underlying defect in the same code. Notes that merely touch the same function are NOT the same defect.
- A note that raises two genuinely distinct defects may appear in two groups.
- Every note id must appear in at least one group.
- Write each group's "statement" as a neutral one-sentence description of the defect itself, in your own words, naming the code involved. Do not copy any note's phrasing and do not comment on how well any note was written.

THE NOTES:

${rendered}

Return ONLY this JSON object:
{"groups":[{"id":"g01","statement":"<neutral one-sentence description of the defect>","members":["m01","m07"]}]}

Number the groups g01, g02, ... in the order you produce them.`;
}

/**
 * Severity. The judge sees the neutral statement only: not the arm, not the
 * wording that produced it, and not how many notes it came from.
 */
export function severityPrompt(issues, code) {
	const rendered = issues
		.map((issue, index) => `j${String(index + 1).padStart(2, "0")}: ${issue.statement}`)
		.join("\n\n");
	return `You are grading candidate defects found during a review of the code below. For each candidate, decide two things independently.

1. real — is this a genuine defect that the visible code evidences? Judge the code, not the wording. A claim about behaviour the code does not have is not real.
2. severity — how bad is it, on exactly this scale:
${SEVERITY_ANCHORS}

Judge each candidate on its own merits. Do not rank them against each other, and do not assume any candidate is real because it was raised.

${code}

THE CANDIDATE DEFECTS:

${rendered}

Return ONLY this JSON object:
{"cases":[{"id":"j01","reasoning":"<one sentence>","real":true,"severity":"blocking"}]}

Use exactly one of blocking, serious, minor, not-an-issue for severity. Return one entry per candidate, in order.`;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function extractJson(text) {
	const trimmed = String(text ?? "").trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1].trim() : trimmed;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start === -1 || end === -1 || end <= start) return null;
	try {
		return JSON.parse(body.slice(start, end + 1));
	} catch {
		return null;
	}
}

export function parseClusters(text, messageIds) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.groups) || value.groups.length === 0) return null;
	const known = new Set(messageIds);
	for (const group of value.groups) {
		if (typeof group?.id !== "string" || typeof group?.statement !== "string") return null;
		if (!Array.isArray(group.members) || group.members.length === 0) return null;
		if (!group.members.every((member) => known.has(member))) return null;
	}
	// Every note must be accounted for: a dropped note silently removes a claim
	// from the pool, which changes every arm's recall denominator.
	const covered = new Set(value.groups.flatMap((group) => group.members));
	if (covered.size !== known.size) return null;
	return value.groups;
}

export function parseSeverities(text, expectedCount) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.cases) || value.cases.length !== expectedCount) return null;
	for (let index = 0; index < value.cases.length; index++) {
		const item = value.cases[index];
		if (item?.id !== `j${String(index + 1).padStart(2, "0")}`) return null;
		if (typeof item.real !== "boolean") return null;
		if (!Object.prototype.hasOwnProperty.call(SEVERITY_WEIGHTS, item.severity)) return null;
		if (typeof item.reasoning !== "string") return null;
	}
	return value.cases;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * An issue's agreed severity. Both judges must call it real, and both must give
 * the same level, or it does not carry weight — the spec forbids averaging two
 * unreliable labels, so a disagreement contributes nothing rather than a mean.
 */
export function agreedSeverity(sol, opus) {
	if (!sol || !opus) return null;
	if (!(sol.real && opus.real)) return { real: false, severity: null, weight: 0 };
	if (sol.severity !== opus.severity) return { real: true, severity: null, weight: null };
	return { real: true, severity: sol.severity, weight: SEVERITY_WEIGHTS[sol.severity] };
}

export function scoreArms(pool, clusters, agreed) {
	const arms = [...new Set(pool.map((item) => item.arm))].sort();
	const byId = new Map(pool.map((item) => [item.id, item]));
	const scored = clusters
		.map((cluster, index) => ({
			...cluster,
			agreed: agreed[index],
			arms: [...new Set(cluster.members.map((member) => byId.get(member)?.arm).filter(Boolean))],
		}))
		.filter((cluster) => cluster.agreed);
	const real = scored.filter((cluster) => cluster.agreed.real && typeof cluster.agreed.weight === "number");
	const totalWeight = real.reduce((sum, cluster) => sum + cluster.agreed.weight, 0);
	const topWeight = real.reduce((max, cluster) => Math.max(max, cluster.agreed.weight), 0);
	const topIssues = real.filter((cluster) => cluster.agreed.weight === topWeight);
	return {
		arms: arms.map((arm) => {
			const found = real.filter((cluster) => cluster.arms.includes(arm));
			const raised = scored.filter((cluster) => cluster.arms.includes(arm));
			const raisedWeight = raised.reduce((sum, cluster) => sum + (cluster.agreed.weight ?? 0), 0);
			const foundWeight = found.reduce((sum, cluster) => sum + cluster.agreed.weight, 0);
			const notReal = raised.filter((cluster) => !cluster.agreed.real).length;
			return {
				arm,
				messages: pool.filter((item) => item.arm === arm).length,
				issuesRaised: raised.length,
				realIssuesFound: found.length,
				notRealRaised: notReal,
				weightedRecall: totalWeight > 0 ? foundWeight / totalWeight : null,
				weightedPrecision: raisedWeight + notReal > 0 ? foundWeight / (raisedWeight + notReal) : null,
				topFindingHit: topIssues.length > 0 && topIssues.some((cluster) => cluster.arms.includes(arm)),
			};
		}),
		totalWeight,
		realIssues: real.length,
		topIssues: topIssues.map((cluster) => ({ id: cluster.id, statement: cluster.statement, arms: cluster.arms })),
	};
}

export function agreementStats(solCases, opusCases) {
	const order = ["not-an-issue", "minor", "serious", "blocking"];
	let exact = 0;
	let adjacent = 0;
	const disagreements = [];
	for (let index = 0; index < solCases.length; index++) {
		const a = solCases[index];
		const b = opusCases[index];
		const distance = Math.abs(order.indexOf(a.severity) - order.indexOf(b.severity));
		if (distance === 0) exact++;
		if (distance <= 1) adjacent++;
		if (distance > 0) disagreements.push({ index, sol: a.severity, opus: b.severity, distance });
	}
	const n = solCases.length;
	const realAgree = solCases.filter((item, index) => item.real === opusCases[index].real).length;
	return {
		n,
		exact,
		exactRate: n > 0 ? exact / n : null,
		adjacent,
		adjacentRate: n > 0 ? adjacent / n : null,
		realAgreement: n > 0 ? realAgree / n : null,
		disagreements,
	};
}

// ---------------------------------------------------------------------------
// Transports (re-stated, see header)
// ---------------------------------------------------------------------------

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
		name: "sol",
		model: model.id,
		async ask(prompt, prior) {
			const messages = prior ? [user(prompt), prior.raw, user(CORRECTION)] : [user(prompt)];
			const result = await streamSimple(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages, tools: [] },
				{ apiKey: credential.access, reasoning: spec.reasoning, maxTokens: 4000 },
			).result();
			const text = (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
			return { text, error: result.errorMessage ?? null, raw: result };
		},
	};
}

function claudeCliTransport(spec, cliTimeoutMs) {
	return {
		name: "opus",
		model: spec.model,
		async ask(prompt, prior) {
			const text = prior ? `${prompt}\n\nYour prior response was structurally invalid:\n${prior.text}\n\n${CORRECTION}` : prompt;
			return new Promise((resolve) => {
				const child = spawn("claude", [
					"-p",
					"--safe-mode",
					"--no-session-persistence",
					"--disable-slash-commands",
					"--tools",
					"",
					"--model",
					spec.model,
					"--effort",
					spec.reasoning,
					"--system-prompt",
					SYSTEM_PROMPT,
					text,
				]);
				let stdout = "";
				let stderr = "";
				const timer = setTimeout(() => child.kill("SIGKILL"), cliTimeoutMs);
				const settle = (error) => {
					clearTimeout(timer);
					resolve({ text: stdout, error, raw: stdout });
				};
				child.stdout.on("data", (chunk) => { stdout += chunk; });
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("error", (error) => settle(error.message));
				child.on("close", (code, signal) => {
					if (signal === "SIGKILL") return settle(`claude killed after ${cliTimeoutMs}ms`);
					settle(code === 0 ? null : stderr.trim() || `claude exited ${code}`);
				});
				child.stdin.end();
			});
		},
	};
}

async function askWithRecovery(transport, prompt, parse) {
	const first = await transport.ask(prompt, null);
	const parsed = first.error ? null : parse(first.text);
	if (parsed) return { parsed, recovered: false };
	if (first.error) throw new Error(`${transport.name}: ${first.error}`);
	const second = await transport.ask(prompt, first);
	const retry = second.error ? null : parse(second.text);
	if (!retry) throw new Error(`${transport.name}: judge returned invalid output twice`);
	return { parsed: retry, recovered: true };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const outputPath = argOf(args, "--output", "");
	const cliTimeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "600000"), 10);
	if (!rowsPath) throw new Error("--rows is required");
	if (!outputPath) throw new Error("--output is required");

	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const pool = poolMessages(rows);
	const code = codeContext(rows);
	console.log(`pooled ${pool.length} delivered messages from ${new Set(pool.map((item) => item.arm)).size} arms`);

	const sol = await piTransport({ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" });
	const opus = claudeCliTransport({ model: "opus", reasoning: "high" }, cliTimeoutMs);

	// Dedupe with one judge; the clustering is printed in full below so a bad
	// merge is inspectable rather than silently reshaping every denominator.
	console.log("clustering...");
	const clusterResult = await askWithRecovery(opus, clusterPrompt(pool), (text) => parseClusters(text, pool.map((item) => item.id)));
	const clusters = clusterResult.parsed;
	console.log(`\n=== CLUSTERING (${clusters.length} distinct issues, recovered=${clusterResult.recovered})\n`);
	const byId = new Map(pool.map((item) => [item.id, item]));
	for (const cluster of clusters) {
		console.log(`${cluster.id}: ${cluster.statement}`);
		for (const member of cluster.members) {
			const item = byId.get(member);
			console.log(`    [${item.arm} p${item.pointIndex} ${item.delivery}] ${item.text.slice(0, 150)}`);
		}
		console.log();
	}

	console.log("judging severity (sol, opus)...");
	const prompt = severityPrompt(clusters, code);
	const [solJudged, opusJudged] = await Promise.all([
		askWithRecovery(sol, prompt, (text) => parseSeverities(text, clusters.length)),
		askWithRecovery(opus, prompt, (text) => parseSeverities(text, clusters.length)),
	]);

	const agreed = clusters.map((_, index) => agreedSeverity(solJudged.parsed[index], opusJudged.parsed[index]));
	const stats = agreementStats(solJudged.parsed, opusJudged.parsed);
	const scores = scoreArms(pool, clusters, agreed);

	const verdict =
		stats.exactRate >= 0.7 && stats.adjacentRate >= 0.9
			? "VIABLE"
			: stats.exactRate < 0.5
				? "NOT VIABLE"
				: "ANCHORS SUSPECT";

	console.log(`\n=== P1 agreement: exact ${stats.exact}/${stats.n} (${(stats.exactRate * 100).toFixed(1)}%), adjacent-or-better ${stats.adjacent}/${stats.n} (${(stats.adjacentRate * 100).toFixed(1)}%), real-flag ${(stats.realAgreement * 100).toFixed(1)}% => ${verdict}`);
	for (const item of stats.disagreements) {
		console.log(`   disagreement ${clusters[item.index].id}: sol=${item.sol} opus=${item.opus} — ${clusters[item.index].statement.slice(0, 110)}`);
	}
	console.log("\n=== per-arm scores");
	for (const arm of scores.arms) {
		console.log(
			`  ${arm.arm.padEnd(5)} messages=${arm.messages} issues=${arm.issuesRaised} real=${arm.realIssuesFound} notReal=${arm.notRealRaised} ` +
				`weightedRecall=${arm.weightedRecall === null ? "—" : (arm.weightedRecall * 100).toFixed(1) + "%"} ` +
				`weightedPrecision=${arm.weightedPrecision === null ? "—" : (arm.weightedPrecision * 100).toFixed(1) + "%"} ` +
				`topFindingHit=${arm.topFindingHit}`,
		);
	}

	writeFileSync(
		outputPath,
		`${JSON.stringify(
			{
				rowsPath,
				pool,
				clusters,
				judgments: { sol: solJudged.parsed, opus: opusJudged.parsed },
				recovered: { cluster: clusterResult.recovered, sol: solJudged.recovered, opus: opusJudged.recovered },
				agreed,
				agreement: stats,
				scores,
				verdict,
				ts: rows[0]?.ts ?? null,
			},
			null,
			1,
		)}\n`,
	);
	console.log(`\nwrote ${outputPath}`);
}
