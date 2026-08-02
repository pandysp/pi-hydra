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
 *    that broke the first consensus round-1 run). Since the cross-task
 *    trajectories (2026-08-02), exporter and dispatcher ALSO have recorded
 *    driver sessions: a session-frame issue there is judged against its
 *    task's recorded rows (--rows-exporter / --rows-dispatcher), a seed-frame
 *    issue against the seeded files. The v1-era premise that "their seeds ARE
 *    their session state" is retired — stage B of the v2 build found 47 of 67
 *    pool candidates carrying seed frames while describing driver-written
 *    artifacts (maskEmail, timeoutMs, the TOTAL line), the RULING 3 bug class
 *    in the accept direction at pool scale.
 * 2. **The four RULINGS are in the rubric**, not applied afterwards, so labels
 *    are produced under them rather than adjusted to them.
 * 3. **Batching is per task AND frame** (`--source auto`, the default, reads
 *    each issue's `frame` field — the v2 mechanical routing; explicit
 *    --source seed|session replays old protocols), so a prompt never carries
 *    a codebase or state none of its issues are about.
 *
 * Round-per-invocation, like the protocol it reuses: the analyst's labels for
 * round N must exist BEFORE the judges are called, and that file is the
 * independence proof. Zero producer spend; both judges subscription-billed.
 *
 * Usage:
 *   node experiments/golden-dataset-consensus.mjs --round 1 --state <dir>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { AXES, PARTICIPANTS, agreed, askJudgeDetailed } from "./severity-consensus.mjs";
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
 * the third. RULING 3 earned its place the same way: the v1 build's rounds
 * 1-2 had both judges rejecting seeded defects (one of them planted) because
 * the driver repaired them mid-session — judging the end state where the set
 * asks about the state the issue's author reviewed. It was argued through
 * deliberation reasons then; stating it here closes the design-doc TODO so
 * labels are produced under it from round 1.
 */
export const RULINGS = `FOUR BINDING CONVENTIONS. Apply them; do not re-litigate them.

REACHABILITY. Judge the harm as if the code path RUNS. Exported, documented
public API counts as reachable BY DEFINITION — a library's callers are not in
its own repository, so "nothing in this repo calls it" is NOT evidence that a
defect is unreachable. Do not discount a defect for lacking a present caller.

INDIVIDUATION. Each issue below names ONE defective expression. Same line, same
consequence, different triggering input is ONE issue and has already been merged
as such. Judge the issue as stated; do not split or merge it.

TEMPORAL FRAME. Judge each issue against the state of the code its statement
describes. A defect of an earlier state does not stop being a defect because a
later edit repaired it — the repair ends the defect's liveness window, it does
not make the claim not-real. "Not present in the final state" is NOT grounds
for rejecting an issue about an earlier state. Symmetrically, an issue about a
later-written artifact is judged against the state in which that artifact
exists.

CALLER-SIDE PRECONDITIONS. Rate the tier under the interaction the issue's
statement names, provided the public contract shown does not forbid that
interaction. "A caller mutates a record it fetched" or "a caller passes an
argument the signature accepts" is part of judging as-if-executed, exactly as
reachability is — do not discount a defect because its harm needs a legal
caller action that has not happened yet in this repository. Discount ONLY a
precondition the shown contract explicitly forbids (a documented "do not
mutate", a stated invariant the caller would have to break).`;

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
export function sourceForTask(taskId, rowsByTask, sourceMode = "session") {
	if (sourceMode !== "seed") {
		const rows = rowsByTask[taskId];
		if (!rows) throw new Error(`${taskId}: session frame requested but no recorded rows supplied (--rows-${taskId})`);
		return codeContext(rows);
	}
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
	const rowsExporterPath = argOf(args, "--rows-exporter", `${process.env.HOME}/scratch/2026-08-01-hydra-cross-task/rows-exporter.jsonl`);
	const rowsDispatcherPath = argOf(args, "--rows-dispatcher", `${process.env.HOME}/scratch/2026-08-02-hydra-cross-task/rows-dispatcher.jsonl`);
	const timeoutMs = Number.parseInt(argOf(args, "--cli-timeout-ms", "900000"), 10);
	const batchSize = Number.parseInt(argOf(args, "--batch-size", "10"), 10);
	const sourceMode = argOf(args, "--source", "auto");
	if (!stateDir) throw new Error("--state <dir> is required");

	const issues = JSON.parse(readFileSync(issuesPath, "utf8")).issues;
	const ids = issues.map((i) => i.id);
	const parseRows = (path) => existsSync(path)
		? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
		: null;
	const rowsByTask = {
		scheduler: parseRows(rowsPath),
		exporter: parseRows(rowsExporterPath),
		dispatcher: parseRows(rowsDispatcherPath),
	};

	// Frame routing is per candidate, not per batch (the v1 symptom-filter
	// repair missed two records — GOLDEN-DATASET-DESIGN.md RULING 3 addendum).
	// "auto" follows each issue's own frame field; an explicit --source
	// seed|session still overrides globally for replaying old protocols.
	const frameFor = (issue) => {
		if (sourceMode !== "auto") return sourceMode;
		if (issue.frame !== "seed" && issue.frame !== "session") {
			throw new Error(`${issue.id}: no frame field — --source auto needs frame on every issue`);
		}
		return issue.frame;
	};
	for (const issue of issues) issue._frame = frameFor(issue);
	const taskFrames = [...new Set(issues.map((i) => `${i.task}:${i._frame}`))].map((key) => key.split(":"));
	const sources = Object.fromEntries(taskFrames.map(([task, frame]) => [
		`${task}:${frame}`,
		sourceForTask(task, rowsByTask, frame),
	]));

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
		for (const [task, frame] of taskFrames) {
			const key = `${task}:${frame}`;
			const forGroup = subset.filter((i) => i.task === task && i._frame === frame);
			for (let i = 0; i < forGroup.length; i += batchSize) out.push({ key, items: forGroup.slice(i, i + batchSize) });
		}
		return out;
	};
	const atomicJson = (path, value) => {
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(value, null, 1));
		renameSync(temporary, path);
	};
	const collectCheckpointed = async (name, batches, promptFor, progress) => {
		const path = `${stateDir}/judge-round${round}-${name}.json`;
		const checkpoint = existsSync(path)
			? JSON.parse(readFileSync(path, "utf8"))
			: { round, judge: name, judgments: {}, batches: [], failures: [] };
		for (const batch of batches) {
			const prompt = promptFor(batch);
			const promptHash = sha(prompt);
			const ids = batch.items.map((item) => item.id);
			const saved = checkpoint.batches.find((item) => item.promptHash === promptHash && ids.every((id) => item.ids.includes(id)));
			if (saved) {
				Object.assign(checkpoint.judgments, saved.judgments);
				process.stderr.write(`  ${name}: resumed ${ids.length} from ${path}\n`);
				continue;
			}
			try {
				const result = await askJudgeDetailed(name, prompt, ids, timeoutMs);
				Object.assign(checkpoint.judgments, result.labels);
				checkpoint.batches.push({
					key: batch.key,
					ids,
					promptHash,
					judge: result.judge,
					attempts: result.attempts,
					judgments: result.labels,
				});
				atomicJson(path, checkpoint);
				process.stderr.write(progress(checkpoint.judgments, ids));
			} catch (error) {
				checkpoint.failures.push({ key: batch.key, ids, promptHash, error: error.message, attempts: error.attempts ?? [] });
				atomicJson(path, checkpoint);
				throw error;
			}
		}
		return checkpoint.judgments;
	};

	let positions;
	if (round === 1) {
		const batches = batchesFor(issues);
		const collect = (name) => collectCheckpointed(
			name,
			batches,
			(batch) => roundOnePrompt(batch.items, sources[batch.key]),
			(merged) => `  ${name}: ${Object.keys(merged).length}/${issues.length}\n`,
		);
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
		const batches = batchesFor(issues.filter((i) => open.includes(i.id)));
		const collect = async (name) => {
			const changed = await collectCheckpointed(
				name,
				batches,
				(batch) => {
					const items = batch.items.map((c) => ({ ...c, mine: prior.positions[name][c.id] }));
					const others = Object.fromEntries(batch.items.map((c) => [
						c.id,
						PARTICIPANTS.filter((p) => p !== name).map((p) => prior.positions[p][c.id]),
					]));
					return deliberationPrompt(items, sources[batch.key], others);
				},
				(_merged, batchIds) => `  ${name}: ${batchIds.length} deliberated\n`,
			);
			return { ...prior.positions[name], ...changed };
		};
		positions = { sol: await collect("sol"), opus: await collect("opus"), analyst };
	}

	const converged = ids.filter((id) => agreed(positions, id));
	state.rounds[round] = { positions, converged, open: ids.filter((id) => !converged.includes(id)) };
	state.issuesPath = issuesPath;
	state.ids = ids;
	atomicJson(statePath, state);

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
		atomicJson(`${stateDir}/open-round${round}.json`, packets);
		process.stdout.write(`open: ${state.rounds[round].open.join(", ")}\npackets: ${stateDir}/open-round${round}.json\n`);
	}
	process.stdout.write(`state hash: ${sha(JSON.stringify(positions)).slice(0, 16)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
