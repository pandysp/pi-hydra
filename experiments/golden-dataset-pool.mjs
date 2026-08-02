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

async function main() {
	const args = process.argv.slice(2);
	const outDir = argOf(args, "--out", "");
	const doCluster = args.includes("--cluster");
	const timeoutMs = Number.parseInt(argOf(args, "--timeout-ms", "900000"), 10);
	if (!outDir) throw new Error("--out <dir> is required");
	mkdirSync(outDir, { recursive: true });

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
