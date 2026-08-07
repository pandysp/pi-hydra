#!/usr/bin/env node
/**
 * Analysis half of the reference-review stage: dedup the union of blind passes,
 * then answer the two questions the stage exists for.
 *
 *   1. Which reference issues are in NEITHER the planted list NOR the
 *      arm-seeded observer pool? Those are the invisible-to-everyone defects —
 *      real problems that no arm reported and we never thought to plant. Their
 *      count is the measured size of the blind spot the golden set would have
 *      had without this stage.
 *   2. Which PLANTED defects did the blind reviewer miss? If it misses some,
 *      its own recall is imperfect and the golden set cannot rest on it alone.
 *      Both directions matter; reporting only the first would flatter it.
 *
 * Dedup and matching are done by a judge, not by string overlap: a keyword
 * match on this material already produced one retraction in this program
 * (96eff06), because "requeues" inside a sentence about the sweep matched the
 * requeue defect. The judge sees statements, never which pass or arm produced
 * them.
 *
 * Usage:
 *   node experiments/reference-review-analyse.mjs --passes passes.json \
 *     --pool out.json --task scheduler --out analysis.json
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const SYSTEM =
	"You are a precise analyst comparing defect descriptions. You judge whether two descriptions identify the same underlying defect in the same code, by mechanism, not by shared vocabulary. You answer only in the requested format.";

function askClaude(prompt, { model = "opus", effort = "high", timeoutMs = 600000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn("claude", [
			"-p", "--safe-mode", "--no-session-persistence", "--disable-slash-commands",
			"--tools", "", "--model", model, "--effort", effort, "--system-prompt", SYSTEM, prompt,
		]);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => { stdout += c; });
		child.stderr.on("data", (c) => { stderr += c; });
		child.on("error", (e) => { clearTimeout(timer); resolve({ text: "", error: e.message }); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal === "SIGKILL") return resolve({ text: stdout, error: `killed after ${timeoutMs}ms` });
			resolve({ text: stdout, error: code === 0 ? null : stderr.trim() || `exited ${code}` });
		});
		child.stdin.end();
	});
}

export function parseJsonBlock(text) {
	const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1] : String(text);
	const start = body.indexOf("[");
	const startObj = body.indexOf("{");
	const from = start === -1 ? startObj : startObj === -1 ? start : Math.min(start, startObj);
	if (from === -1) throw new Error("no JSON found in response");
	const end = Math.max(body.lastIndexOf("]"), body.lastIndexOf("}"));
	return JSON.parse(body.slice(from, end + 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const passesPath = argOf(args, "--passes", "");
	const poolPath = argOf(args, "--pool", "");
	const taskId = argOf(args, "--task", "scheduler");
	const outPath = argOf(args, "--out", "");
	if (!passesPath || !poolPath || !outPath) throw new Error("--passes, --pool and --out are required");

	const passes = JSON.parse(readFileSync(passesPath, "utf8"));
	const poolDoc = JSON.parse(readFileSync(poolPath, "utf8"));
	const task = TRAJECTORY_TASKS.find((t) => t.id === taskId);

	const lines = passes.passes.flatMap((p) => p.lines.map((line) => ({ pass: p.pass, line })));
	const numbered = lines.map((entry, i) => `R${String(i + 1).padStart(2, "0")}: ${entry.line}`).join("\n");

	// Stage A — dedup the union into distinct defects.
	const dedupPrompt = `Below are ${lines.length} defect descriptions produced by three independent reviews of the SAME codebase. Many describe the same underlying defect in different words.

Group them: two descriptions belong to the same group if they identify the same underlying defect in the same code — same mechanism, same root cause. Different consequences of the same root cause are the SAME group. Different defects in the same function are DIFFERENT groups.

${numbered}

Answer with a JSON array, one object per distinct defect:
[{"id":"D01","statement":"one sentence naming the function and the mechanism","members":["R01","R14"]}]
Every input id must appear in exactly one group.`;

	console.error(`stage A: dedup ${lines.length} lines`);
	const dedupRaw = await askClaude(dedupPrompt);
	if (dedupRaw.error) throw new Error(`dedup failed: ${dedupRaw.error}`);
	const groups = parseJsonBlock(dedupRaw.text);
	console.error(`  ${groups.length} distinct reference defects`);

	// Stage B — match each reference defect against the planted list and the observer pool.
	const planted = task.defects.map((d) => `P-${d.id}: ${d.target}`).join("\n");
	const pool = poolDoc.candidates.map((c, i) => `O${String(i + 1).padStart(2, "0")}: ${c.statement}`).join("\n");
	const refs = groups.map((g) => `${g.id}: ${g.statement}`).join("\n");

	const matchPrompt = `You are matching defect descriptions by MECHANISM, not by shared words.

REFERENCE DEFECTS (found by a blind reviewer):
${refs}

PLANTED DEFECTS (the ones deliberately seeded):
${planted}

OBSERVER POOL (defects reported by observer agents during a run):
${pool}

For each REFERENCE defect, decide whether it identifies the same underlying defect as any planted defect, and whether it identifies the same underlying defect as any observer-pool entry.

Same underlying defect = same root cause in the same code, even if worded differently or if a different consequence is emphasised. If the root cause differs (e.g. one is about omitting an argument, the other about supplying a hostile value), say so in "note" and set the match to null.

Answer with a JSON array:
[{"id":"D01","planted":"P-sched-claim-toctou"|null,"pool":"O13"|null,"note":"short reason when either is null or borderline"}]
One object per reference defect, all of them.`;

	console.error("stage B: match against planted + pool");
	const matchRaw = await askClaude(matchPrompt);
	if (matchRaw.error) throw new Error(`match failed: ${matchRaw.error}`);
	const matches = parseJsonBlock(matchRaw.text);

	const byId = Object.fromEntries(matches.map((m) => [m.id, m]));
	const enriched = groups.map((g) => ({ ...g, match: byId[g.id] ?? null }));
	const novel = enriched.filter((g) => !g.match?.planted && !g.match?.pool);
	const plantedFound = new Set(matches.map((m) => m.planted).filter(Boolean));
	const plantedMissed = task.defects.filter((d) => !plantedFound.has(`P-${d.id}`));

	writeFileSync(outPath, JSON.stringify({ task: taskId, lines, groups: enriched, novel, plantedFound: [...plantedFound], plantedMissed: plantedMissed.map((d) => d.id) }, null, 2));

	console.error(`\ndistinct reference defects: ${groups.length}`);
	console.error(`NOT planted and NOT in the observer pool: ${novel.length}`);
	console.error(`planted defects found by the blind reviewer: ${plantedFound.size}/${task.defects.length}`);
	console.error(`planted defects MISSED: ${plantedMissed.map((d) => d.id).join(", ") || "none"}`);
	console.error(`wrote ${outPath}`);
}
