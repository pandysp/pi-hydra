#!/usr/bin/env node
/**
 * Golden dataset v1, stage 2: tier every clustered issue by running the
 * consensus protocol (`CONSENSUS-SPEC.md`) over the union pool. Three
 * participants — sol, opus and the analyst — label two binary axes and
 * deliberate until they agree; dissent that survives is recorded verbatim,
 * never averaged.
 *
 * Three differences from `severity-consensus.mjs`, all forced by the union:
 *
 * 1. **Per-task source.** The pool now spans three codebases. Scheduler issues
 *    are judged against the recorded session (start AND end state — the driver
 *    wrote `stats`, `deadLetter` and the docs mid-run, and judging those
 *    against the seed measures the prompt, not the judgment: that is the bug
 *    that broke the first consensus round-1 run). Exporter and dispatcher were
 *    never touched by a driver, so their seeded files ARE their session state.
 * 2. **The two RULINGS are in the rubric**, not applied afterwards, so labels
 *    are produced under them rather than adjusted to them.
 * 3. **Batching is per task**, so a prompt never carries a codebase none of its
 *    issues are about.
 *
 * Round-per-invocation, like the protocol it reuses: the analyst's labels for
 * round N must exist BEFORE the judges are called, and that file is the
 * independence proof. Zero producer spend; both judges subscription-billed.
 *
 * Usage:
 *   node experiments/golden-dataset-consensus.mjs --round 1 --state <dir>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { AXES, PARTICIPANTS, agreed, askJudge } from "./severity-consensus.mjs";
import { codeContext } from "./severity-pool-probe.mjs";
import { TRAJECTORY_TASKS, setupTask } from "./trajectory-cost-tasks.mjs";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const sha = (text) => createHash("sha256").update(text).digest("hex");

/**
 * RULING 1 is stated as a judging instruction because it decides real labels:
 * the first consensus run stalled 2-1 on exactly this question (`renewLease`
 * is exported and documented, but nothing in the repo calls it). Leaving the
 * convention unstated made two participants answer a different question from
 * the third.
 */
export const RULINGS = `TWO BINDING CONVENTIONS. Apply them; do not re-litigate them.

REACHABILITY. Judge the harm as if the code path RUNS. Exported, documented
public API counts as reachable BY DEFINITION — a library's callers are not in
its own repository, so "nothing in this repo calls it" is NOT evidence that a
defect is unreachable. Do not discount a defect for lacking a present caller.

INDIVIDUATION. Each issue below names ONE defective expression. Same line, same
consequence, different triggering input is ONE issue and has already been merged
as such. Judge the issue as stated; do not split or merge it.`;

export const RUBRIC = `Two independent yes/no questions per issue. Do NOT grade on a scale.

blocking — TRUE only if you would hold a release for it: it causes data loss,
silent incorrect results, permanent resource capture, a security hole, or
duplicate execution of real work. Cost, noise, missing tests, documentation
defects and reporting inaccuracies are NOT blocking however annoying.

anyHarm — TRUE if the issue is a genuine defect evidenced by the code or docs
shown, of any size. FALSE if it is not real, not evidenced, or purely a matter
of taste.

${RULINGS}

Judge each issue as stated against the source below. Answer for every issue.`;

/** Seeded files for a task that no driver ever edited: its seed IS its state. */
export function seededSource(taskId) {
	const task = TRAJECTORY_TASKS.find((t) => t.id === taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);
	const root = mkdtempSync(join(tmpdir(), `golden-${taskId}-`));
	setupTask(task, root);
	const files = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				// `reference/` is copied pi-hydra project docs used only as token
				// mass for the driver; it is not code under review.
				if (entry !== "reference") walk(full);
			} else if (/\.(js|md)$/.test(entry)) {
				files.push([relative(root, full), readFileSync(full, "utf8")]);
			}
		}
	};
	walk(root);
	return files.sort(([a], [b]) => a.localeCompare(b)).map(([path, body]) => `----- ${path}\n${body}`).join("\n");
}

/**
 * Which state an issue is judged against is part of the question, not a
 * detail: the v1 build's rounds 1-2 showed both judges rejecting SEEDED
 * defects (including a planted one) because the driver repaired them
 * mid-session — they were answering "is this in the end state" where the
 * set needs "was this a defect of the state the author reviewed"
 * (GOLDEN-DATASET-DESIGN.md RULING 3). `--source seed` judges against the
 * seeded files even for the scheduler; use it for issues whose authors saw
 * only the seed (planted, reference-review). The default session source is
 * correct for observer/code-review issues about driver-written artifacts.
 */
export function sourceForTask(taskId, schedulerRows, sourceMode = "session") {
	if (taskId === "scheduler" && sourceMode !== "seed") return codeContext(schedulerRows);
	return `THE CODE UNDER REVIEW (the seeded state, before any session):\n\n${seededSource(taskId)}`;
}

function roundOnePrompt(issues, source) {
	return `${RUBRIC}

SOURCE UNDER REVIEW
${source}

ISSUES
${issues.map((i) => `[${i.id}] ${i.statement}`).join("\n")}

Return ONLY:
{"judgments":[{"id":"<id>","blocking":true|false,"anyHarm":true|false,"reason":"<one sentence>"}]}`;
}

function deliberationPrompt(issues, source, others) {
	return `${RUBRIC}

SOURCE UNDER REVIEW
${source}

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

async function main() {
	const args = process.argv.slice(2);
	const round = Number.parseInt(argOf(args, "--round", "1"), 10);
	const stateDir = argOf(args, "--state", "");
	const issuesPath = argOf(args, "--issues", `${stateDir}/issues.json`);
	const rowsPath = argOf(args, "--rows", `${process.env.HOME}/scratch/2026-08-01-hydra-c2-trajectory/rows.jsonl`);
	const timeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "900000"), 10);
	const batchSize = Number.parseInt(argOf(args, "--batch-size", "10"), 10);
	const sourceMode = argOf(args, "--source", "session");
	if (!stateDir) throw new Error("--state <dir> is required");

	const issues = JSON.parse(readFileSync(issuesPath, "utf8")).issues;
	const ids = issues.map((i) => i.id);
	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const tasks = [...new Set(issues.map((i) => i.task))];
	const sources = Object.fromEntries(tasks.map((t) => [t, sourceForTask(t, rows, sourceMode)]));

	const statePath = `${stateDir}/consensus.json`;
	const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { rounds: {} };

	const analystPath = `${stateDir}/analyst-round${round}.json`;
	if (!existsSync(analystPath)) {
		throw new Error(`${analystPath} missing — the analyst is a participant and must record positions for round ${round} BEFORE the judges are called`);
	}
	const analyst = JSON.parse(readFileSync(analystPath, "utf8")).labels;
	const missing = ids.filter((id) => !analyst[id]);
	if (missing.length > 0) throw new Error(`analyst omitted ${missing.length} issue(s): ${missing.slice(0, 8).join(", ")}`);

	const batchesFor = (subset) => {
		const out = [];
		for (const task of tasks) {
			const forTask = subset.filter((i) => i.task === task);
			for (let i = 0; i < forTask.length; i += batchSize) out.push({ task, items: forTask.slice(i, i + batchSize) });
		}
		return out;
	};

	let positions;
	if (round === 1) {
		const collect = async (name) => {
			const merged = {};
			for (const batch of batchesFor(issues)) {
				const got = await askJudge(name, roundOnePrompt(batch.items, sources[batch.task]), batch.items.map((b) => b.id), timeoutMs);
				Object.assign(merged, got);
				process.stderr.write(`  ${name}: ${Object.keys(merged).length}/${issues.length}\n`);
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
		process.stderr.write(`deliberating ${open.length} open issue(s)\n`);
		const collect = async (name) => {
			const merged = { ...prior.positions[name] };
			for (const batch of batchesFor(issues.filter((i) => open.includes(i.id)))) {
				const items = batch.items.map((c) => ({ ...c, mine: prior.positions[name][c.id] }));
				const others = Object.fromEntries(batch.items.map((c) => [
					c.id,
					PARTICIPANTS.filter((p) => p !== name).map((p) => prior.positions[p][c.id]),
				]));
				const got = await askJudge(name, deliberationPrompt(items, sources[batch.task], others), batch.items.map((b) => b.id), timeoutMs);
				Object.assign(merged, got);
				process.stderr.write(`  ${name}: ${batch.items.length} deliberated\n`);
			}
			return merged;
		};
		positions = { sol: await collect("sol"), opus: await collect("opus"), analyst };
	}

	const converged = ids.filter((id) => agreed(positions, id));
	state.rounds[round] = { positions, converged, open: ids.filter((id) => !converged.includes(id)) };
	state.issuesPath = issuesPath;
	state.ids = ids;
	writeFileSync(statePath, JSON.stringify(state, null, 1));

	process.stdout.write(`round ${round}: ${converged.length}/${ids.length} converged\n`);
	if (state.rounds[round].open.length > 0) {
		const packets = {};
		for (const id of state.rounds[round].open) {
			packets[id] = {
				statement: issues.find((i) => i.id === id).statement,
				task: issues.find((i) => i.id === id).task,
				others: Object.fromEntries(PARTICIPANTS.map((p) => [p, positions[p][id]])),
			};
		}
		writeFileSync(`${stateDir}/open-round${round}.json`, JSON.stringify(packets, null, 1));
		process.stdout.write(`open: ${state.rounds[round].open.join(", ")}\npackets: ${stateDir}/open-round${round}.json\n`);
	}
	process.stdout.write(`state hash: ${sha(JSON.stringify(positions)).slice(0, 16)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
