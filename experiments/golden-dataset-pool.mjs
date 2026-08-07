#!/usr/bin/env node
/**
 * Golden dataset v1, stage 1: union the four discovery sources into one
 * candidate list, then cluster them into distinct issues under RULING 2
 * (`GOLDEN-DATASET-DESIGN.md`): ONE ISSUE PER DEFECTIVE EXPRESSION, not per
 * trigger. Same line + same consequence + different input = one issue.
 *
 * Why a judge clusters rather than a string metric: the four sources describe
 * the same defect in deliberately different registers — a planted target
 * ("Increment attempts on requeue instead of resetting it to 0"), a reference
 * line ("`requeue` writes `attempts: 0` instead of incrementing"), a measured
 * code-review finding, and an observer's mid-trajectory note. No lexical
 * measure merges those three and still splits the five DIFFERENT defective
 * expressions that all live inside `sweepExpired`.
 *
 * The clustering is the step v1 of the severity probe got wrong: its judge
 * folded a message naming two planted defects into one cluster, and MAIN's
 * strongest finding became invisible to scoring. So this stage PRINTS every
 * cluster with its members and their source, and the analyst reviews the
 * mapping before consensus runs. A merge nobody can see is a merge nobody can
 * check.
 *
 * Stage 2 (`golden-dataset-consensus.mjs`) tiers the clusters. Zero producer
 * spend at every stage; the clustering judge is subscription-billed.
 *
 * Usage:
 *   node experiments/golden-dataset-pool.mjs --out <dir>            # normalise
 *   node experiments/golden-dataset-pool.mjs --out <dir> --cluster  # + judge
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const REFERENCE = "experiments/artifacts/2026-08-01-reference-review/analysis.json.gz";
const OBSERVER = "experiments/artifacts/2026-08-01-severity-probe-v2/out.json.gz";
const CODE_REVIEW = `${process.env.HOME}/scratch/2026-08-01-golden-corpus-verify/findings.json`;

export const SOURCES = ["planted", "reference-review", "code-review", "observer"];

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Task inference. Reference and observer both cover the scheduler trajectory
 * only; code-review findings carry their task in the file path. */
export function taskOf(source, record) {
	if (source === "planted") return record.task;
	if (source === "code-review") return String(record.file).split("/")[0];
	return "scheduler";
}

/**
 * Mechanical frame derivation (GOLDEN-DATASET-DESIGN.md, RULING 3 addendum).
 * v1 routed frames by a SYMPTOM filter and missed two records (the audit's
 * SCHED-r-d22 and SCHED-r-d04); the frame is provenance, not a symptom:
 * - planted and reference-review authors saw only the seed;
 * - code-review followed the artifact's scope note (the 2026-08-01 run
 *   reviewed the driver-run-scheduler tree, so its scheduler findings are
 *   session-frame; exporter/dispatcher are byte-identical to the seed);
 * - observer claims describe the trajectory they watched. All three tasks now
 *   have recorded start/end state; `seeded` marks a seed-era expression and
 *   every other observer claim is session-frame.
 */
export function frameOf(source, record) {
	const task = record.task ?? taskOf(source, record);
	if (source === "planted" || source === "reference-review") return "seed";
	if (source === "code-review") return task === "scheduler" ? "session" : "seed";
	if (source === "observer") {
		return record.seeded ? "seed" : "session";
	}
	throw new Error(`frameOf: unknown source ${source}`);
}

export function loadCandidates() {
	const out = [];

	for (const task of TRAJECTORY_TASKS) {
		for (const defect of task.defects) {
			out.push({
				srcId: `P-${defect.id}`,
				source: "planted",
				task: task.id,
				statement: defect.target,
				anchors: {
					expression: String(defect.expression ?? ""),
					declaration: String(defect.declaration ?? ""),
					identifier: defect.identifier ?? null,
					file: defect.file,
					match: "regex",
					state: "seed",
				},
				plantedId: defect.id,
			});
		}
	}

	const reference = JSON.parse(gunzipSync(readFileSync(REFERENCE)).toString());
	for (const group of reference.groups) {
		out.push({
			srcId: `R-${group.id}`,
			source: "reference-review",
			task: "scheduler",
			statement: group.statement,
			passes: (group.members ?? []).length,
			priorMatch: group.match ?? null,
		});
	}

	const findings = JSON.parse(readFileSync(CODE_REVIEW, "utf8"));
	findings.forEach((finding, index) => {
		out.push({
			srcId: `C-${String(index + 1).padStart(2, "0")}`,
			source: "code-review",
			task: taskOf("code-review", finding),
			statement: finding.summary,
			// The measured scenario is what makes these the strongest candidates:
			// they were executed, not asserted. Kept for the record, not judged.
			evidence: finding.failure_scenario,
			site: `${finding.file}:${finding.line}`,
			driverIntroduced: /^DRIVER-INTRODUCED/.test(finding.summary),
		});
	});

	const observer = JSON.parse(gunzipSync(readFileSync(OBSERVER)).toString());
	for (const candidate of observer.candidates) {
		out.push({
			srcId: `O-${candidate.id}`,
			source: "observer",
			task: "scheduler",
			statement: candidate.statement,
			plantedId: (candidate.planted ?? [])[0] ?? null,
			seeded: !!candidate.seeded,
		});
	}

	for (const c of out) c.frame = frameOf(c.source, c);
	return out;
}

/* ------------------------------------------------------------------ v2 --- */

const BLIND_REVIEW = (task) => `${process.env.HOME}/scratch/2026-08-02-golden-v2/blind-review-${task}.json`;
const CROSS_TASK = (task) => `experiments/artifacts/2026-08-02-cross-task-trajectory/severity-${task}.json.gz`;
const RUNNERS_UP = "experiments/artifacts/2026-08-01-code-review-max/runners-up.json";

/**
 * The 13 runner-up bullets, individuated under RULING 2 by the analyst
 * (2026-08-02). Several bullets bundle 2-3 defective expressions with
 * disjoint consequences and fixes — the same one-report-one-cluster gap the
 * audit found on EXP-c-12 — so they are split BEFORE clustering, where the
 * v1 pipeline could not. Every split is visible in mapping.txt for review.
 * Scheduler bullets (#7, #12, #13) entered against the V2 spec's
 * "no scheduler deepening" boundary on the parent's explicit instruction;
 * they carry `boundaryNote` so stage B can drop them consciously.
 */
const RUNNER_UP_SPLITS = {
	3: [
		["a", "format.js's duration math carries minutes and seconds without an hour carry and without rounding guards, so boundary values render nonsense (119999 -> \"1m60s\", 3599999 -> \"59m60s\", 86400000 -> \"1440m00s\")."],
		["b", "format.js's duration formatter has no input guard, so NaN or undefined milliseconds render as \"NaNmNaNs\" instead of failing or falling back."],
	],
	6: [
		["a", "exportFilename interpolates the caller-supplied tenant into the filename without sanitising path separators or CRLF, enabling path traversal (orders-../../etc/passwd-....csv) and header injection."],
		["b", "exportFilename stamps the date via new Date(now).toISOString().slice(0,10), a UTC slice that names the wrong day near midnight in any non-UTC deployment."],
	],
	7: [
		["a", "complete(store, id, null) retires a never-claimed job because the owner check compares null !== null, which is false."],
		["b", "A stale owner can complete a job a sweep already returned to pending, because complete does not re-check current claim state."],
	],
	12: [
		["a", "renewLease, sweepExpired and putJob are exported with zero call sites, so leases are never renewed in any shipped path."],
		["b", "countOrders and exportFilename are exported with zero call sites in the exporter."],
	],
	9: [
		["a", "createClient consumes the caller's response array via shift(), destroying the caller's own data structure as a side effect."],
		["b", "A drained scripted client fabricates a synthetic 200 success for any request beyond the scripted responses, so under-scripted failure scenarios silently pass."],
		["c", "The audit record createClient exposes is mutable by callers, so the record of sent requests can be silently altered after the fact."],
	],
	11: [
		["a", "The CSV writer emits LF line endings without a BOM, so Excel misparses multibyte names (Müller mojibake) against the CRLF+BOM interop convention."],
		["b", "Row dates are stringified locale-dependently instead of in a fixed format, so the same table exports differently across deployments."],
	],
	13: [
		["a", "claimNext sorts the full backlog on every call (714k comparisons per tick at 50k jobs) where a priority structure or partial scan would do."],
		["b", "logSummary makes three full map scans per call and emits ~36k lines/hour on an idle scheduler."],
	],
};

export function loadCandidatesV2() {
	const out = [];

	for (const task of ["exporter", "dispatcher"]) {
		const review = JSON.parse(readFileSync(BLIND_REVIEW(task), "utf8"));
		review.reviews.forEach((pass, passIndex) => {
			pass.findings.forEach((finding, findingIndex) => {
				out.push({
					srcId: `R-B${task[0].toUpperCase()}${passIndex + 1}-${String(findingIndex + 1).padStart(2, "0")}`,
					source: "reference-review",
					task,
					statement: finding.statement,
					anchors: {
						expression: String(finding.defectiveExpression).slice(0, 160),
						file: finding.file,
						match: "literal",
						state: "seed",
					},
					site: finding.file,
					evidence: [finding.consequence, finding.trigger].filter(Boolean).join(" — "),
					confidence: finding.confidence ?? null,
				});
			});
		});
	}

	for (const task of ["exporter", "dispatcher"]) {
		const pool = JSON.parse(gunzipSync(readFileSync(CROSS_TASK(task))).toString());
		for (const candidate of pool.candidates) {
			out.push({
				srcId: `O-X${task[0].toUpperCase()}-${candidate.id}`,
				source: "observer",
				task,
				statement: candidate.statement,
				plantedId: (candidate.planted ?? [])[0] ?? null,
				seeded: !!candidate.seeded,
			});
		}
	}

	// Task per bullet, stated rather than inferred: format.js (#3) is the
	// scheduler's (its test is the scheduler's only test file); #12 spans two
	// tasks and splits accordingly (clusters must not span tasks).
	const RUNNER_UP_TASK = {
		1: "exporter", 2: "exporter", 3: "scheduler", 4: "dispatcher",
		5: "exporter", 6: "exporter", 7: "scheduler", 8: "exporter",
		9: "dispatcher", 10: "dispatcher", 11: "exporter",
		12: { a: "scheduler", b: "exporter" }, 13: "scheduler",
	};
	const runners = JSON.parse(readFileSync(RUNNERS_UP, "utf8"));
	runners.runnersUp.forEach((entry) => {
		const index = entry.index;
		const splits = RUNNER_UP_SPLITS[index];
		const parts = splits ?? [[null, entry.verbatim]];
		for (const [suffix, statement] of parts) {
			const taskSpec = RUNNER_UP_TASK[index];
			const task = typeof taskSpec === "string" ? taskSpec : taskSpec[suffix];
			if (!task) throw new Error(`no task for runner-up #${index}${suffix ?? ""}`);
			out.push({
				srcId: `C-RU${String(index).padStart(2, "0")}${suffix ?? ""}`,
				source: "code-review",
				task,
				statement,
				evidence: entry.verbatim,
				...(task === "scheduler" ? { boundaryNote: "scheduler deepening — V2 spec boundary; included on the parent's explicit instruction" } : {}),
			});
		}
	});

	for (const c of out) c.frame = frameOf(c.source, c);
	return out;
}

const CLUSTER_PROMPT = (candidates) => `You are de-duplicating defect reports for a benchmark reference set.

Four independent sources reported defects in the same three codebases: seeded
defects, a blind reference review, a max-effort code review, and observations
from agents watching a session. The same defect is described in different words
by different sources; different defects sometimes sit in the same function.

THE INDIVIDUATION RULE, which is binding:
ONE ISSUE PER DEFECTIVE EXPRESSION, NOT PER TRIGGER. Same line of code, same
consequence, reached by a different input = ONE issue. Different lines, or the
same line with genuinely independent failure modes = DIFFERENT issues.

Worked examples of the rule:
- "renewLease computes expiry from caller-supplied now, so a hostile far-future
  timestamp holds the job forever" and "renewLease has no default for now, so
  omitting it stores NaN and the job never expires" are ONE issue: same
  expression, same consequence (the lease never expires), different input.
- "sweepExpired keeps claimedBy so swept jobs are unclaimable" and "sweepExpired
  writes stale snapshots that clobber a concurrent completion" are TWO issues:
  different defective expressions inside the same function.

Group the reports below. Be conservative: when unsure whether two reports name
the same defective expression, keep them SEPARATE. A wrongly split pair costs a
duplicate record; a wrongly merged pair makes a real defect invisible.

REPORTS
${candidates.map((c) => `[${c.srcId}] (${c.task}) ${c.statement}`).join("\n")}

Return ONLY:
{"clusters":[{"members":["<srcId>",...],"statement":"<one sentence naming the defective expression and its consequence>"}]}
Every srcId above must appear in exactly one cluster.`;

const CLUSTER_PROMPT_V2 = (candidates, existing) => `You are de-duplicating NEW defect reports against an EXISTING benchmark reference set, and clustering whatever is genuinely new.

THE INDIVIDUATION RULE, which is binding:
ONE ISSUE PER DEFECTIVE EXPRESSION, NOT PER TRIGGER. Same line of code, same
consequence, reached by a different input = ONE issue. Different lines, or the
same line with genuinely independent failure modes = DIFFERENT issues.

EXISTING ISSUES (fixed — do not restate, split, or merge them):
${existing.map((e) => `[${e.id}] (${e.task}, ${e.status}) ${e.statement}`).join("\n")}

NEW REPORTS
${candidates.map((c) => `[${c.srcId}] (${c.task}) ${c.statement}`).join("\n")}

For each new report: if it names the SAME defective expression as an existing
issue (active or rejected), assign it to that issue's id. Otherwise cluster it
with other new reports naming the same defective expression. Be conservative:
when unsure, keep reports SEPARATE and do NOT match them to an existing issue —
a wrong match silently converts a new defect into coverage credit.

Return ONLY:
{"clusters":[{"existing":"<existing id or null>","members":["<srcId>",...],"statement":"<one sentence naming the defective expression and its consequence; empty string when existing is set>"}]}
Every new srcId must appear in exactly one cluster. Never put an existing id in members.`;

export function parseClustersV2(text, expectedIds, existingIds) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) throw new Error("no JSON object in clustering output");
	const clusters = JSON.parse(match[0]).clusters;
	if (!Array.isArray(clusters)) throw new Error("clusters must be an array");
	const seen = new Set();
	for (const cluster of clusters) {
		if (cluster.existing != null && !existingIds.includes(cluster.existing)) {
			throw new Error(`clustering matched unknown existing id: ${cluster.existing}`);
		}
		for (const member of cluster.members ?? []) {
			if (seen.has(member)) throw new Error(`${member} appears in more than one cluster`);
			seen.add(member);
		}
	}
	const missing = expectedIds.filter((id) => !seen.has(id));
	const unknown = [...seen].filter((id) => !expectedIds.includes(id));
	if (unknown.length > 0) throw new Error(`clustering invented ids: ${unknown.join(", ")}`);
	if (missing.length > 0) throw new Error(`clustering dropped ${missing.length}: ${missing.join(", ")}`);
	return clusters;
}

/** Novel clusters must be frame-uniform: a candidate judged against the seed
 * and one judged against a session state cannot share one consensus question. */
export function assertSingleFrame(clusters, byId) {
	for (const cluster of clusters) {
		if (cluster.existing != null) continue;
		const frames = new Set(cluster.members.map((m) => byId[m].frame));
		if (frames.size > 1) throw new Error(`cluster spans frames ${[...frames].join(",")}: ${cluster.members.join(", ")}`);
	}
}

function askOpus(prompt, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn("claude", [
			"-p", "--safe-mode", "--no-session-persistence", "--disable-slash-commands",
			"--tools", "", "--model", "opus", "--effort", "high",
			"--system-prompt", "You are an independent software-review benchmark judge.",
			prompt,
		]);
		let stdout = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.on("error", (error) => { clearTimeout(timer); resolve({ text: stdout, error: error.message }); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal === "SIGKILL") return resolve({ text: stdout, error: `killed after ${timeoutMs}ms` });
			resolve({ text: stdout, error: code === 0 ? null : `exited ${code}` });
		});
		child.stdin.end();
	});
}

export function parseClusters(text, expectedIds) {
	const match = String(text).match(/\{[\s\S]*\}/);
	if (!match) throw new Error("no JSON object in clustering output");
	const clusters = JSON.parse(match[0]).clusters;
	if (!Array.isArray(clusters)) throw new Error("clusters must be an array");
	const seen = new Set();
	for (const cluster of clusters) {
		for (const member of cluster.members ?? []) {
			if (seen.has(member)) throw new Error(`${member} appears in more than one cluster`);
			seen.add(member);
		}
	}
	const missing = expectedIds.filter((id) => !seen.has(id));
	const unknown = [...seen].filter((id) => !expectedIds.includes(id));
	if (unknown.length > 0) throw new Error(`clustering invented ids: ${unknown.join(", ")}`);
	// A total mapping is an invariant, not a nicety: a dropped candidate is a
	// defect silently absent from the reference set.
	if (missing.length > 0) throw new Error(`clustering dropped ${missing.length}: ${missing.join(", ")}`);
	return clusters;
}

/** Clusters must not span tasks: a scheduler defect and an exporter defect are
 * never the same defective expression, whatever the wording suggests. */
export function assertSingleTask(clusters, byId) {
	for (const cluster of clusters) {
		const tasks = new Set(cluster.members.map((m) => byId[m].task));
		if (tasks.size > 1) throw new Error(`cluster spans tasks ${[...tasks].join(",")}: ${cluster.members.join(", ")}`);
	}
}

function render(clusters, byId) {
	const lines = [];
	clusters.forEach((cluster, index) => {
		const id = `I${String(index + 1).padStart(2, "0")}`;
		const task = byId[cluster.members[0]].task;
		const sources = [...new Set(cluster.members.map((m) => byId[m].source))].sort();
		lines.push(`${id} (${task}) [${sources.join("+")}] ${cluster.statement}`);
		for (const member of cluster.members) {
			lines.push(`      ${member.padEnd(7)} ${byId[member].source.padEnd(16)} ${byId[member].statement.slice(0, 96)}`);
		}
	});
	return lines.join("\n");
}

async function mainV2(outDir, timeoutMs, doCluster) {
	const candidates = loadCandidatesV2();
	const byId = Object.fromEntries(candidates.map((c) => [c.srcId, c]));
	writeFileSync(`${outDir}/candidates.json`, JSON.stringify({ candidates }, null, 1));

	const dataset = JSON.parse(readFileSync("experiments/golden-dataset.json", "utf8"));
	const existing = [...dataset.issues, ...dataset.rejected].map((r) => ({ id: r.id, task: r.task, status: r.status, statement: r.statement }));
	const existingTask = Object.fromEntries(existing.map((e) => [e.id, e.task]));

	const bySource = {};
	for (const c of candidates) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
	process.stdout.write(`v2 candidates: ${candidates.length} ${JSON.stringify(bySource)} vs ${existing.length} existing records (dataset ${dataset.version})\n`);
	if (!doCluster) return;

	const ids = candidates.map((c) => c.srcId);
	const attempt = await askOpus(CLUSTER_PROMPT_V2(candidates, existing), timeoutMs);
	if (attempt.error && !attempt.text) throw new Error(`clustering failed: ${attempt.error}`);
	const clusters = parseClustersV2(attempt.text, ids, existing.map((e) => e.id));
	for (const cluster of clusters) {
		const tasks = new Set(cluster.members.map((m) => byId[m].task));
		if (tasks.size > 1) throw new Error(`cluster spans tasks ${[...tasks].join(",")}: ${cluster.members.join(", ")}`);
		if (cluster.existing != null && existingTask[cluster.existing] !== [...tasks][0]) {
			throw new Error(`${cluster.members.join(",")} (${[...tasks][0]}) matched to ${cluster.existing} (${existingTask[cluster.existing]}) across tasks`);
		}
	}
	assertSingleFrame(clusters, byId);

	const credit = {};
	for (const cluster of clusters.filter((c) => c.existing != null)) {
		credit[cluster.existing] = [...(credit[cluster.existing] ?? []), ...cluster.members];
	}
	const novel = clusters.filter((c) => c.existing == null).map((cluster, index) => ({
		id: `V2-I${String(index + 1).padStart(2, "0")}`,
		task: byId[cluster.members[0]].task,
		frame: byId[cluster.members[0]].frame,
		statement: cluster.statement,
		members: cluster.members,
		sources: [...new Set(cluster.members.map((m) => byId[m].source))].sort(),
		planted: cluster.members.map((m) => byId[m].plantedId).filter(Boolean),
		boundaryNote: cluster.members.map((m) => byId[m].boundaryNote).find(Boolean) ?? undefined,
	}));

	writeFileSync(`${outDir}/issues.json`, JSON.stringify({ issues: novel, clusteredAt: new Date().toISOString(), sourceHash: sha(JSON.stringify(candidates)).slice(0, 16), baseVersion: dataset.version }, null, 1));
	writeFileSync(`${outDir}/credit.json`, JSON.stringify({ baseVersion: dataset.version, credit }, null, 1));
	const lines = [`CREDIT (new reports matching existing records)`];
	for (const [id, members] of Object.entries(credit)) {
		lines.push(`${id}`);
		for (const m of members) lines.push(`      ${m.padEnd(12)} ${byId[m].statement.slice(0, 96)}`);
	}
	lines.push("", "NOVEL CLUSTERS");
	novel.forEach((issue) => {
		lines.push(`${issue.id} (${issue.task}, ${issue.frame}) [${issue.sources.join("+")}]${issue.boundaryNote ? " [BOUNDARY]" : ""} ${issue.statement}`);
		for (const m of issue.members) lines.push(`      ${m.padEnd(12)} ${byId[m].source.padEnd(16)} ${byId[m].statement.slice(0, 96)}`);
	});
	writeFileSync(`${outDir}/mapping.txt`, lines.join("\n"));
	process.stdout.write(`credited: ${Object.values(credit).flat().length} reports onto ${Object.keys(credit).length} existing records\nnovel clusters: ${novel.length}\nmapping printed to ${outDir}/mapping.txt — REVIEW IT before consensus\n`);
}

async function main() {
	const args = process.argv.slice(2);
	const outDir = argOf(args, "--out", "");
	const doCluster = args.includes("--cluster");
	const timeoutMs = Number.parseInt(argOf(args, "--timeout-ms", "900000"), 10);
	if (!outDir) throw new Error("--out <dir> is required");
	mkdirSync(outDir, { recursive: true });
	if (args.includes("--v2")) return mainV2(outDir, timeoutMs, doCluster);

	const candidates = loadCandidates();
	const byId = Object.fromEntries(candidates.map((c) => [c.srcId, c]));
	writeFileSync(`${outDir}/candidates.json`, JSON.stringify({ candidates }, null, 1));

	const bySource = {};
	const byTask = {};
	for (const c of candidates) {
		bySource[c.source] = (bySource[c.source] ?? 0) + 1;
		byTask[c.task] = (byTask[c.task] ?? 0) + 1;
	}
	process.stdout.write(`candidates: ${candidates.length}\n  by source: ${JSON.stringify(bySource)}\n  by task:   ${JSON.stringify(byTask)}\n`);

	if (!doCluster) return;

	const ids = candidates.map((c) => c.srcId);
	const attempt = await askOpus(CLUSTER_PROMPT(candidates), timeoutMs);
	if (attempt.error && !attempt.text) throw new Error(`clustering failed: ${attempt.error}`);
	const clusters = parseClusters(attempt.text, ids);
	assertSingleTask(clusters, byId);

	const issues = clusters.map((cluster, index) => ({
		id: `I${String(index + 1).padStart(2, "0")}`,
		task: byId[cluster.members[0]].task,
		statement: cluster.statement,
		members: cluster.members,
		sources: [...new Set(cluster.members.map((m) => byId[m].source))].sort(),
		planted: cluster.members.map((m) => byId[m].plantedId).filter(Boolean),
		driverIntroduced: cluster.members.some((m) => byId[m].driverIntroduced),
	}));

	writeFileSync(`${outDir}/issues.json`, JSON.stringify({ issues, clusteredAt: new Date().toISOString(), sourceHash: sha(JSON.stringify(candidates)).slice(0, 16) }, null, 1));
	writeFileSync(`${outDir}/mapping.txt`, render(clusters, byId));
	process.stdout.write(`\nclusters: ${issues.length} (from ${candidates.length} reports)\n`);
	process.stdout.write(`mapping printed to ${outDir}/mapping.txt — REVIEW IT before consensus\n`);

	const plantedCovered = new Set(issues.flatMap((i) => i.planted));
	const allPlanted = TRAJECTORY_TASKS.flatMap((t) => t.defects.map((d) => d.id));
	const uncovered = allPlanted.filter((id) => !plantedCovered.has(id));
	process.stdout.write(`planted covered: ${plantedCovered.size}/${allPlanted.length}${uncovered.length ? ` — MISSING ${uncovered.join(", ")}` : ""}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
