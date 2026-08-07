#!/usr/bin/env node
/**
 * REFERENCE REVIEW — the independent-discovery stage of the golden dataset
 * (`GOLDEN-DATASET-DESIGN.md`, Build step 2).
 *
 * The observer pool is arm-seeded: an issue no arm mentions never enters it, so
 * a real defect that every arm misses AND we failed to plant is invisible, and
 * every arm scores full recall on a set that silently excludes it. We have a
 * measured instance — the lease-clock defect entered the pool only because it
 * was planted; no arm described it. This stage is the only mechanism that finds
 * that class.
 *
 * BLINDNESS IS THE WHOLE POINT. The reviewer sees the authored source and
 * nothing else: no planted-defect list, no observer message, no results doc.
 * Seeing any of those collapses independent discovery into confirmation. The
 * prompt is built from `task.files` alone; `task.defects` is never read here.
 *
 * SCOPE. It reviews the SEEDED state, not the driver's mid-run damage. The
 * golden set is per-TASK and stable; damage a driver inflicts during one run
 * ("two edits corrupted braces") is per-RUN and belongs to the bonus category
 * by construction — it cannot be authored into a task-level set.
 *
 * Three independent passes, union taken: one pass under-reports, and the
 * per-pass overlap is itself the evidence for how much.
 *
 * Usage:
 *   node experiments/reference-review.mjs --task scheduler --out out.json
 *   node experiments/reference-review.mjs --task scheduler --out out.json --passes 3
 *
 * Zero producer spend: the reviewer is the Claude CLI on the subscription.
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { argOf } from "./lib.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const REVIEWER_SYSTEM =
	"You are a meticulous senior engineer reviewing unfamiliar source code. You report defects you can point at in the code shown. You never invent problems to seem thorough, and you never soften a real one.";

/**
 * The reviewer is asked for mechanism, not severity and not ranking: severity
 * is settled later by the consensus protocol, and asking for it here would
 * anchor that protocol on one model's opinion.
 */
export function reviewPrompt(bundle) {
	return `Review this codebase and list EVERY defect you find.

${bundle}

Rules for your answer:
- One defect per line, prefixed with "- ".
- State the MECHANISM: what the code does, and what goes wrong because of it.
- Name the function or file so the defect can be located.
- Do not rank them. Do not assign severity. Do not summarise.
- Include correctness, concurrency, resource, security and data-integrity
  defects. Ignore formatting and naming preferences.
- If a defect only matters under a condition, say the condition.
- List everything you find, even if some are minor.`;
}

/** Every authored file, path-headed. `task.defects` is deliberately not read. */
export function bundleFor(task) {
	return Object.entries(task.files)
		.map(([path, content]) => `===== FILE: ${path} =====\n${content}`)
		.join("\n\n");
}

export function parseDefectLines(text) {
	return String(text ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^[-*]\s+/.test(line))
		.map((line) => line.replace(/^[-*]\s+/, "").trim())
		.filter((line) => line.length > 20);
}

/** Two statements are the same defect if they name the same symbol and agree on the mechanism verb. */
export function normalizeStatement(statement) {
	return String(statement)
		.toLowerCase()
		.replace(/[`"'*]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function symbolsIn(statement, symbols) {
	const lower = String(statement).toLowerCase();
	return symbols.filter((symbol) => lower.includes(symbol.toLowerCase()));
}

function askClaude(prompt, { model = "opus", effort = "xhigh", timeoutMs = 600000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn("claude", [
			"-p",
			"--safe-mode",
			"--no-session-persistence",
			"--disable-slash-commands",
			"--tools",
			"",
			"--model",
			model,
			"--effort",
			effort,
			"--system-prompt",
			REVIEWER_SYSTEM,
			prompt,
		]);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => { clearTimeout(timer); resolve({ text: "", error: error.message }); });
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (signal === "SIGKILL") return resolve({ text: stdout, error: `killed after ${timeoutMs}ms` });
			resolve({ text: stdout, error: code === 0 ? null : stderr.trim() || `exited ${code}` });
		});
		child.stdin.end();
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const taskId = argOf(args, "--task", "scheduler");
	const outPath = argOf(args, "--out", "");
	const passes = Number.parseInt(argOf(args, "--passes", "3"), 10);
	if (!outPath) throw new Error("--out is required");

	const task = TRAJECTORY_TASKS.find((item) => item.id === taskId);
	if (!task) throw new Error(`unknown task: ${taskId}`);

	const bundle = bundleFor(task);
	const prompt = reviewPrompt(bundle);
	// Assert blindness structurally rather than trusting the prompt builder: if a
	// planted identifier's DEFECT TEXT ever leaked in, the run is void.
	for (const defect of task.defects) {
		if (prompt.includes(defect.target)) throw new Error(`blindness violated: planted target text for ${defect.id} is in the prompt`);
	}
	console.error(`bundle ${bundle.length} chars, ${passes} passes, blindness asserted against ${task.defects.length} planted targets`);

	const results = [];
	for (let pass = 1; pass <= passes; pass++) {
		const started = Date.now();
		const response = await askClaude(prompt);
		const lines = parseDefectLines(response.text);
		console.error(`  pass ${pass}: ${lines.length} defect lines, ${Math.round((Date.now() - started) / 1000)}s${response.error ? ` ERROR ${response.error}` : ""}`);
		results.push({ pass, error: response.error, lines, raw: response.text });
	}

	writeFileSync(
		outPath,
		JSON.stringify(
			{
				task: taskId,
				promptHash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
				bundleChars: bundle.length,
				passes: results,
			},
			null,
			2,
		),
	);
	console.error(`wrote ${outPath}`);
}
