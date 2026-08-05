#!/usr/bin/env node
/**
 * SEVERITY-POOLING PROBE v2 — NOT A SHIPPED METRIC.
 *
 * Pre-registered in `SEVERITY-PROBE-V2-SPEC.md` (42c0646). v1
 * (`severity-pool-probe.mjs`, results in `SEVERITY-PROBE-RESULTS.md`) returned
 * NOT VIABLE at 41.7% exact severity agreement. v1 stays on disk untouched;
 * this file supersedes it and implements the three pre-registered fixes.
 *
 * F1 DECOMPOSE. No judge is ever asked for a blended "severity". Each judge
 * answers three independent factual questions per candidate issue —
 * `harmIfExecuted` (with reachability discounting explicitly FORBIDDEN in the
 * prompt), `reachable`, `inDeliverable` — and the analyst blends afterwards,
 * two ways, both reported. v1's disagreement was two competent judges silently
 * supplying two different blending conventions; this removes the discretion.
 *
 * F2 NO MESSAGE CLUSTERING. v1 clustered whole messages and swallowed MAIN's
 * p6, which names two distinct planted defects in one sentence, into a single
 * group — MAIN's only blocking-class finding became invisible to the scoring.
 * v2 extracts atomic CLAIMS per message first (a message may yield several,
 * from both judges, unioned), and dedupes claims rather than messages, so a
 * multi-defect message credits every defect it names.
 *
 * F3 SEED THE POOL. v1 pooled only what some arm said, so a defect nobody found
 * could never enter the reference set and recall was measured over the
 * collectively-found set. v2 matches the planted defects against the deduped
 * issues in a separate pass (kept separate so showing them to the dedupe judge
 * cannot bias the grouping) and admits any unmatched planted defect as its own
 * candidate issue with zero members — which is what makes a universal miss
 * scoreable.
 *
 * Blindness, both directions, carried from v1: judges never see which arm
 * produced a message, and the severity judge reads a neutral canonical
 * statement rather than any arm's wording, so phrasing quality cannot leak into
 * a label.
 *
 * The two transports are RE-STATED rather than imported: the judge script
 * parses argv and runs its matrix on import (`delivery-context-golden-judge.mjs`
 * :15-33). House precedent, `trajectory-cost-ab.mjs:31-33`.
 *
 * Zero producer spend: judges only, both subscription-billed.
 *
 * Usage:
 *   node experiments/severity-pool-probe-v2.mjs --rows rows.jsonl --output out.json
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "../lib.mjs";
import { codeContext, messageTextOf, poolMessages } from "../severity-pool-probe.mjs";

const SYSTEM_PROMPT = "You are an independent software-review benchmark judge.";
const CORRECTION =
	"Your output did not match the required JSON schema or case count. Preserve every judgment and return only the corrected JSON object.";

export { codeContext, messageTextOf, poolMessages };

// ---------------------------------------------------------------------------
// The decomposed scale (F1)
// ---------------------------------------------------------------------------

/** Weights for the mechanism blend. `none` is the not-real level. */
export const HARM_WEIGHTS = Object.freeze({
	blocking: 9,
	serious: 3,
	minor: 1,
	none: 0,
});

/** Ordered worst-first for adjacency and for the practical blend's shifts. */
export const HARM_ORDER = Object.freeze(["none", "minor", "serious", "blocking"]);

export const HARM_ANCHORS = `blocking — data loss, a security hole, corrupted state, or something that breaks production.
serious — wrong behaviour or a silent failure that will bite in normal operation.
minor — redundancy, a missing test on a low-risk path, style, or a cosmetic problem.
none — no harm follows, OR the claim describes behaviour the code does not actually have.`;

/**
 * v1's judges split on two conventions the anchors never stated. Both are now
 * separate questions, and question 1 forbids the discounting explicitly.
 */
export function judgePrompt(issues, code, conventions = "") {
	const rendered = issues
		.map((issue, index) => `j${String(index + 1).padStart(2, "0")}: ${issue.statement}`)
		.join("\n\n");
	return `You are grading candidate defects found during a review of the code below. For each candidate answer THREE INDEPENDENT questions. Do not blend them into a single judgement, and do not rank the candidates against each other.

1. harmIfExecuted — ASSUMING this code path runs as written, what is the worst plausible outcome?
${HARM_ANCHORS}
   DO NOT discount for whether the path can currently be reached. That is question 2, and answering it here would double-count it. Grade the mechanism as if it executes.
   Answer "none" only when no harm would follow even if it ran, or when the claim describes behaviour the visible code does not have.

2. reachable — can this path actually execute, given the rest of the visible code?
   yes — some visible path reaches it.
   no — the rest of the code prevents it from ever running as described.
   unclear — the visible code does not settle it.

3. inDeliverable — is the defect in, or does it break, what the user explicitly asked the agent to produce in this session?
   yes / no. Judge the user's stated request, not how interesting the defect is.

${conventions ? `${conventions}\n\n` : ""}${code}

THE CANDIDATE DEFECTS:

${rendered}

Return ONLY this JSON object:
{"cases":[{"id":"j01","reasoning":"<one sentence>","harmIfExecuted":"blocking","reachable":"yes","inDeliverable":false}]}

harmIfExecuted must be exactly one of blocking, serious, minor, none. reachable must be exactly one of yes, no, unclear. inDeliverable must be a boolean. Return one entry per candidate, in order.`;
}

// ---------------------------------------------------------------------------
// Stage 1 — claim extraction (F2)
// ---------------------------------------------------------------------------

/**
 * Atomic claims, not whole messages. The prompt is blind (ids only) and the
 * multi-claim case is stated as the norm rather than a permitted exception,
 * because v1's clustering prompt permitted it and the judge still collapsed it.
 */
export function extractPrompt(messages) {
	const rendered = messages.map((item) => `${item.id}: ${item.text}`).join("\n\n");
	return `Several code reviewers wrote short review notes about one coding session. A single note often raises MORE THAN ONE distinct defect — for example a note may name a concurrency race AND a separate state-handling bug in the same sentence.

Split every note into the distinct DEFECT CLAIMS it makes.

Rules:
- One claim per distinct underlying defect. If a note names two defects, emit two claims for that note. If it names three, emit three.
- Do not split one defect into several claims merely because the note has several clauses about it.
- A note that makes no defect claim at all (pure process comment) may yield zero claims.
- Write each claim as a neutral one-sentence description of the defect itself, naming the code involved, in your own words. Do not copy the note's phrasing and do not comment on how well the note was written.

THE NOTES:

${rendered}

Return ONLY this JSON object:
{"claims":[{"note":"m01","statement":"<neutral one-sentence description of one defect>"}]}

Emit the claims grouped by note, notes in the order given.`;
}

export function parseClaims(text, messageIds) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.claims)) return null;
	const known = new Set(messageIds);
	for (const claim of value.claims) {
		if (typeof claim?.note !== "string" || !known.has(claim.note)) return null;
		if (typeof claim?.statement !== "string" || claim.statement.trim().length === 0) return null;
	}
	return value.claims;
}

/** Both judges extract; the union is deduped. A claim carries its source note, so arm attribution is unaffected by which extractor found it. */
export function unionClaims(perJudge) {
	const claims = [];
	for (const [judge, list] of Object.entries(perJudge)) {
		for (const claim of list) {
			claims.push({ id: `c${String(claims.length + 1).padStart(2, "0")}`, note: claim.note, statement: claim.statement.trim(), extractor: judge });
		}
	}
	return claims;
}

// ---------------------------------------------------------------------------
// Stage 2a — dedupe claims into candidate issues (F2)
// ---------------------------------------------------------------------------

export function dedupePrompt(claims) {
	const rendered = claims.map((claim) => `${claim.id}: ${claim.statement}`).join("\n");
	return `Below are defect claims extracted from code-review notes. Different reviewers describe the same underlying defect in different words, and the same defect may appear several times.

Group the claims by the UNDERLYING DEFECT they describe.

Rules:
- Two claims belong to the same group only if they describe the same underlying defect in the same code. Claims that merely touch the same function are NOT the same defect.
- Every claim id must appear in exactly one group.
- Write each group's "statement" as a neutral one-sentence description of the defect itself, naming the code involved.

THE CLAIMS:

${rendered}

Return ONLY this JSON object:
{"groups":[{"id":"g01","statement":"<neutral one-sentence description>","members":["c01","c07"]}]}

Number the groups g01, g02, ... in the order you produce them.`;
}

export function parseGroups(text, claimIds) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.groups) || value.groups.length === 0) return null;
	const known = new Set(claimIds);
	const seen = new Set();
	for (const group of value.groups) {
		if (typeof group?.id !== "string" || typeof group?.statement !== "string") return null;
		if (!Array.isArray(group.members) || group.members.length === 0) return null;
		for (const member of group.members) {
			if (!known.has(member) || seen.has(member)) return null;
			seen.add(member);
		}
	}
	if (seen.size !== known.size) return null;
	return value.groups;
}

// ---------------------------------------------------------------------------
// Stage 2b — match the planted defects (F3)
// ---------------------------------------------------------------------------

/**
 * Kept as its OWN pass, after grouping. Showing the planted set to the dedupe
 * judge would let a vague claim be pulled toward a planted statement, which is
 * the bias F3 must not introduce while fixing the pooling bias.
 */
export function plantedMatchPrompt(defects, groups) {
	const renderedDefects = defects.map((defect, index) => `p${index + 1}: ${defect.target}`).join("\n\n");
	const renderedGroups = groups.map((group) => `${group.id}: ${group.statement}`).join("\n");
	return `Below are REFERENCE DEFECTS that are known to exist in a codebase, and CANDIDATE DESCRIPTIONS written by reviewers of that codebase.

For each reference defect, list every candidate description that describes THAT SAME defect.

Rules:
- A candidate matches only if it describes the same underlying defect: the same wrong behaviour in the same code. A candidate that describes a DOWNSTREAM CONSEQUENCE of the defect, or merely mentions the same function, does NOT match.
- A reference defect may match zero candidates. Say so with an empty list — that is a normal and expected answer.
- A candidate may match more than one reference defect only if it genuinely describes both.

THE REFERENCE DEFECTS:

${renderedDefects}

THE CANDIDATE DESCRIPTIONS:

${renderedGroups}

Return ONLY this JSON object:
{"matches":[{"defect":"p1","candidates":["g03"]}]}

Return one entry per reference defect, in order, with an empty candidates array where nothing matches.`;
}

export function parseMatches(text, defectCount, groupIds) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.matches) || value.matches.length !== defectCount) return null;
	const known = new Set(groupIds);
	for (let index = 0; index < value.matches.length; index++) {
		const match = value.matches[index];
		if (match?.defect !== `p${index + 1}`) return null;
		if (!Array.isArray(match.candidates)) return null;
		if (!match.candidates.every((id) => known.has(id))) return null;
	}
	return value.matches;
}

/**
 * The candidate-issue set the judges grade: every deduped group, plus one entry
 * per planted defect that matched nothing. An unmatched planted defect has no
 * members, so every arm scores zero on it — the behaviour v1 could not express.
 */
export function buildCandidates(groups, defects, matches) {
	const matchedGroupIds = new Set(matches.flatMap((match) => match.candidates));
	const plantedByGroup = new Map();
	matches.forEach((match, index) => {
		for (const id of match.candidates) {
			if (!plantedByGroup.has(id)) plantedByGroup.set(id, []);
			plantedByGroup.get(id).push(defects[index].id);
		}
	});
	const fromGroups = groups.map((group) => ({
		id: group.id,
		statement: group.statement,
		members: group.members,
		planted: plantedByGroup.get(group.id) ?? [],
		seeded: false,
	}));
	const unmatched = defects
		.filter((_, index) => matches[index].candidates.length === 0)
		.map((defect, offset) => ({
			id: `s${String(offset + 1).padStart(2, "0")}`,
			statement: defect.target,
			members: [],
			planted: [defect.id],
			seeded: true,
		}));
	return { candidates: [...fromGroups, ...unmatched], matchedGroupIds };
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

export function parseJudgments(text, expectedCount) {
	const value = extractJson(text);
	if (!value || !Array.isArray(value.cases) || value.cases.length !== expectedCount) return null;
	for (let index = 0; index < value.cases.length; index++) {
		const item = value.cases[index];
		if (item?.id !== `j${String(index + 1).padStart(2, "0")}`) return null;
		if (!Object.prototype.hasOwnProperty.call(HARM_WEIGHTS, item.harmIfExecuted)) return null;
		if (!["yes", "no", "unclear"].includes(item.reachable)) return null;
		if (typeof item.inDeliverable !== "boolean") return null;
		if (typeof item.reasoning !== "string") return null;
	}
	return value.cases;
}

// ---------------------------------------------------------------------------
// Blending (F1) — the analyst's job, done two ways, both reported
// ---------------------------------------------------------------------------

function shift(level, steps) {
	const index = HARM_ORDER.indexOf(level);
	return HARM_ORDER[Math.min(HARM_ORDER.length - 1, Math.max(0, index + steps))];
}

/**
 * Both blends use the AGREED `harmIfExecuted` only — a disagreement carries no
 * weight, never a mean (v1's rule, carried forward).
 *
 * The practical blend adjusts one level down for `reachable === "no"` and one
 * level up for `inDeliverable === true`. Pre-data analyst decision, stated
 * because the spec does not: an adjustment applies ONLY when both judges agree
 * on that field. Disagreement means no adjustment, which is the same
 * "never average an unreliable label" rule applied to the modifiers.
 */
export function blend(sol, opus) {
	if (!sol || !opus) return null;
	const agreedHarm = sol.harmIfExecuted === opus.harmIfExecuted ? sol.harmIfExecuted : null;
	const agreedReachable = sol.reachable === opus.reachable ? sol.reachable : null;
	const agreedInDeliverable = sol.inDeliverable === opus.inDeliverable ? sol.inDeliverable : null;
	if (agreedHarm === null) {
		return { agreedHarm: null, mechanism: null, practical: null, agreedReachable, agreedInDeliverable };
	}
	let practicalLevel = agreedHarm;
	if (agreedReachable === "no") practicalLevel = shift(practicalLevel, -1);
	if (agreedInDeliverable === true) practicalLevel = shift(practicalLevel, 1);
	return {
		agreedHarm,
		agreedReachable,
		agreedInDeliverable,
		mechanism: HARM_WEIGHTS[agreedHarm],
		practical: HARM_WEIGHTS[practicalLevel],
		practicalLevel,
	};
}

export function agreementStats(solCases, opusCases) {
	let exact = 0;
	let adjacent = 0;
	const disagreements = [];
	for (let index = 0; index < solCases.length; index++) {
		const a = solCases[index];
		const b = opusCases[index];
		const distance = Math.abs(HARM_ORDER.indexOf(a.harmIfExecuted) - HARM_ORDER.indexOf(b.harmIfExecuted));
		if (distance === 0) exact++;
		if (distance <= 1) adjacent++;
		if (distance > 0) disagreements.push({ index, sol: a.harmIfExecuted, opus: b.harmIfExecuted, distance });
	}
	const n = solCases.length;
	const reach = solCases.filter((item, index) => item.reachable === opusCases[index].reachable).length;
	const deliver = solCases.filter((item, index) => item.inDeliverable === opusCases[index].inDeliverable).length;
	return {
		n,
		exact,
		exactRate: n > 0 ? exact / n : null,
		adjacent,
		adjacentRate: n > 0 ? adjacent / n : null,
		reachableAgreement: n > 0 ? reach / n : null,
		inDeliverableAgreement: n > 0 ? deliver / n : null,
		disagreements,
	};
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export function scoreArms(pool, claims, candidates, blends) {
	const arms = [...new Set(pool.map((item) => item.arm))].sort();
	const noteArm = new Map(pool.map((item) => [item.id, item.arm]));
	const claimArm = new Map(claims.map((claim) => [claim.id, noteArm.get(claim.note)]));
	const enriched = candidates.map((candidate, index) => ({
		...candidate,
		blend: blends[index],
		arms: [...new Set(candidate.members.map((member) => claimArm.get(member)).filter(Boolean))],
	}));
	const weighted = (key) => {
		const real = enriched.filter((item) => item.blend && typeof item.blend[key] === "number" && item.blend[key] > 0);
		const total = real.reduce((sum, item) => sum + item.blend[key], 0);
		const top = real.reduce((max, item) => Math.max(max, item.blend[key]), 0);
		const topIssues = real.filter((item) => item.blend[key] === top);
		return {
			totalWeight: total,
			realIssues: real.length,
			topIssues: topIssues.map((item) => ({ id: item.id, statement: item.statement, arms: item.arms })),
			arms: arms.map((arm) => {
				const found = real.filter((item) => item.arms.includes(arm));
				const foundWeight = found.reduce((sum, item) => sum + item.blend[key], 0);
				const raised = enriched.filter((item) => item.arms.includes(arm) && item.blend);
				const noHarm = raised.filter((item) => item.blend.agreedHarm === "none").length;
				const raisedWeight = raised.reduce((sum, item) => sum + (item.blend[key] ?? 0), 0);
				return {
					arm,
					weightedRecall: total > 0 ? foundWeight / total : null,
					weightedPrecision: raisedWeight + noHarm > 0 ? foundWeight / (raisedWeight + noHarm) : null,
					realIssuesFound: found.length,
					topFindingHit: topIssues.length > 0 && topIssues.some((item) => item.arms.includes(arm)),
				};
			}),
		};
	};
	const perArmCounts = arms.map((arm) => {
		const raised = enriched.filter((item) => item.arms.includes(arm));
		return {
			arm,
			messages: pool.filter((item) => item.arm === arm).length,
			claims: claims.filter((claim) => claimArm.get(claim.id) === arm).length,
			issuesRaised: raised.length,
			notRealRaised: raised.filter((item) => item.blend?.agreedHarm === "none").length,
			disagreedRaised: raised.filter((item) => item.blend && item.blend.agreedHarm === null).length,
		};
	});
	return { enriched, counts: perArmCounts, mechanism: weighted("mechanism"), practical: weighted("practical") };
}

// ---------------------------------------------------------------------------
// Transports (re-stated, see header)
// ---------------------------------------------------------------------------

export async function piTransport(spec) {
	const [{ streamSimple }, { resolveModel }] = await Promise.all([
		import("@earendil-works/pi-ai/compat"),
		import("../model-catalog.mjs"),
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
				{ apiKey: credential.access, reasoning: spec.reasoning, maxTokens: 6000 },
			).result();
			const text = (result?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
			return { text, error: result.errorMessage ?? null, raw: result };
		},
	};
}

export function claudeCliTransport(spec, cliTimeoutMs) {
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

export async function askWithRecovery(transport, prompt, parse) {
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
	const taskId = argOf(args, "--task", "scheduler");
	const cliTimeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "900000"), 10);
	if (!rowsPath) throw new Error("--rows is required");
	if (!outputPath) throw new Error("--output is required");

	const { TRAJECTORY_TASKS } = await import("../trajectory-cost-tasks.mjs");
	const task = TRAJECTORY_TASKS.find((item) => item.id === taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);

	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const pool = poolMessages(rows);
	const code = codeContext(rows);
	console.log(`pooled ${pool.length} delivered messages from ${new Set(pool.map((item) => item.arm)).size} arms; ${task.defects.length} planted defects seeded`);

	const sol = await piTransport({ provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" });
	const opus = claudeCliTransport({ model: "opus", reasoning: "high" }, cliTimeoutMs);

	// Stage 1: both judges extract atomic claims; the union is deduped.
	console.log("extracting claims (sol, opus)...");
	const ids = pool.map((item) => item.id);
	const [solClaims, opusClaims] = await Promise.all([
		askWithRecovery(sol, extractPrompt(pool), (text) => parseClaims(text, ids)),
		askWithRecovery(opus, extractPrompt(pool), (text) => parseClaims(text, ids)),
	]);
	const claims = unionClaims({ sol: solClaims.parsed, opus: opusClaims.parsed });
	const byNote = new Map();
	for (const claim of claims) byNote.set(claim.note, (byNote.get(claim.note) ?? 0) + 1);
	console.log(`  sol ${solClaims.parsed.length} claims, opus ${opusClaims.parsed.length} claims, union ${claims.length}`);
	const multi = [...byNote.entries()].filter(([, count]) => count > 2);
	console.log(`  notes yielding more than one claim per extractor: ${multi.length}`);

	// Stage 2a: dedupe claims (NOT messages).
	console.log("deduping claims...");
	const groupResult = await askWithRecovery(opus, dedupePrompt(claims), (text) => parseGroups(text, claims.map((claim) => claim.id)));
	const groups = groupResult.parsed;
	const claimById = new Map(claims.map((claim) => [claim.id, claim]));
	const noteArm = new Map(pool.map((item) => [item.id, item.arm]));
	console.log(`\n=== GROUPING (${groups.length} distinct issues, recovered=${groupResult.recovered})\n`);
	for (const group of groups) {
		console.log(`${group.id}: ${group.statement}`);
		for (const member of group.members) {
			const claim = claimById.get(member);
			console.log(`    [${noteArm.get(claim.note)} ${claim.note} via ${claim.extractor}] ${claim.statement.slice(0, 130)}`);
		}
		console.log();
	}

	// Stage 2b: match the planted defects, as a separate pass.
	console.log("matching planted defects...");
	const matchResult = await askWithRecovery(
		opus,
		plantedMatchPrompt(task.defects, groups),
		(text) => parseMatches(text, task.defects.length, groups.map((group) => group.id)),
	);
	const { candidates } = buildCandidates(groups, task.defects, matchResult.parsed);
	console.log("\n=== PLANTED MATCHES");
	matchResult.parsed.forEach((match, index) => {
		console.log(`  ${task.defects[index].id}: ${match.candidates.length ? match.candidates.join(", ") : "NOT FOUND BY ANY ARM (seeded into the pool)"}`);
	});

	console.log(`\njudging ${candidates.length} candidate issues on three decomposed questions (sol, opus)...`);
	const prompt = judgePrompt(candidates, code);
	const [solJudged, opusJudged] = await Promise.all([
		askWithRecovery(sol, prompt, (text) => parseJudgments(text, candidates.length)),
		askWithRecovery(opus, prompt, (text) => parseJudgments(text, candidates.length)),
	]);

	const blends = candidates.map((_, index) => blend(solJudged.parsed[index], opusJudged.parsed[index]));
	const stats = agreementStats(solJudged.parsed, opusJudged.parsed);
	const scores = scoreArms(pool, claims, candidates, blends);

	const verdict =
		stats.exactRate >= 0.7 ? "VIABLE" : stats.exactRate < 0.6 ? "NOT VIABLE — STOP" : "MARGINAL";

	console.log(
		`\n=== V1 GATE harmIfExecuted exact ${stats.exact}/${stats.n} (${(stats.exactRate * 100).toFixed(1)}%), ` +
			`adjacent ${(stats.adjacentRate * 100).toFixed(1)}% => ${verdict}`,
	);
	console.log(
		`=== V2 reachable ${(stats.reachableAgreement * 100).toFixed(1)}%, inDeliverable ${(stats.inDeliverableAgreement * 100).toFixed(1)}%`,
	);
	for (const item of stats.disagreements) {
		console.log(`   disagreement ${candidates[item.index].id}: sol=${item.sol} opus=${item.opus} — ${candidates[item.index].statement.slice(0, 100)}`);
	}
	for (const key of ["mechanism", "practical"]) {
		console.log(`\n=== ${key} blend (total weight ${scores[key].totalWeight}, ${scores[key].realIssues} weighted issues)`);
		for (const arm of scores[key].arms) {
			console.log(
				`  ${arm.arm.padEnd(5)} recall=${arm.weightedRecall === null ? "—" : (arm.weightedRecall * 100).toFixed(1) + "%"} ` +
					`precision=${arm.weightedPrecision === null ? "—" : (arm.weightedPrecision * 100).toFixed(1) + "%"} ` +
					`found=${arm.realIssuesFound} topHit=${arm.topFindingHit}`,
			);
		}
	}
	console.log("\n=== per-arm counts");
	for (const item of scores.counts) {
		console.log(`  ${item.arm.padEnd(5)} messages=${item.messages} claims=${item.claims} issues=${item.issuesRaised} noHarm=${item.notRealRaised} disagreed=${item.disagreedRaised}`);
	}

	writeFileSync(
		outputPath,
		`${JSON.stringify(
			{
				rowsPath,
				task: taskId,
				pool,
				claims,
				extraction: { sol: solClaims.parsed, opus: opusClaims.parsed },
				groups,
				plantedMatches: matchResult.parsed,
				candidates,
				judgments: { sol: solJudged.parsed, opus: opusJudged.parsed },
				recovered: {
					extractSol: solClaims.recovered,
					extractOpus: opusClaims.recovered,
					group: groupResult.recovered,
					match: matchResult.recovered,
					sol: solJudged.recovered,
					opus: opusJudged.recovered,
				},
				blends,
				agreement: stats,
				scores,
				verdict,
			},
			null,
			1,
		)}\n`,
	);
	console.log(`\nwrote ${outputPath}`);
}
