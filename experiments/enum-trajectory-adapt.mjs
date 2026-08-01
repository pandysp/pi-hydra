#!/usr/bin/env node
/**
 * Adapts LIVE-FORK TRAJECTORY rows into the shape `severity-pool-probe-v2.mjs`
 * consumes, so the resolved metric (blocking / anyHarm,
 * `SEVERITY-V4-BLOCKING-TIER.md`) scores a trajectory run with no change to the
 * judging pipeline.
 *
 * Sibling of `enum-plus-adapt.mjs`, which does the same job for PROBE rows.
 * Trajectory rows already carry `kind:"observation"` and `arm`, so the id
 * conversion that adapter needs is unnecessary here. What is still necessary —
 * and load-bearing — is FORMAT NORMALISATION: ENUM answers with a `findings`
 * array, MAIN with a single `message` string, F2 with prose plus a DELIVERY
 * footer. Feeding those to a blind judge unchanged would show it clean prose
 * from two arms and raw JSON from a third, which is format leakage into a
 * comparison that is supposed to be blind. Every arm is rendered as prose here.
 *
 * `normalizeText` and `findingCount` are imported rather than re-stated, so the
 * trajectory scoring and the probe scoring cannot drift apart.
 *
 * Usage:
 *   node experiments/enum-trajectory-adapt.mjs --rows rows.jsonl --output adapted.jsonl
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { findingCount, normalizeText } from "./enum-plus-adapt.mjs";

/**
 * Delivered observations only. A `none` row carries no claim, and the pipeline
 * scores what was SAID; silence is measured separately by the cost/delivery
 * counts, not by the judges.
 */
export function adaptTrajectory(rows) {
	const observations = rows
		.filter((row) => row.kind === "observation" && !row.error && row.valid !== false)
		.filter((row) => row.delivery && row.delivery !== "none")
		.map((row) => ({
			...row,
			responseText: normalizeText(row.responseText),
			rawResponseText: row.responseText,
			findingCount: findingCount(row.responseText),
		}));
	const fileStates = rows.filter((row) => row.kind === "file-state");
	if (fileStates.length === 0) throw new Error("trajectory carries no file-state rows: codeContext would throw");
	return [...fileStates, ...observations];
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const outputPath = argOf(args, "--output", "");
	if (!rowsPath || !outputPath) throw new Error("--rows and --output are required");
	const rows = readFileSync(rowsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const adapted = adaptTrajectory(rows);
	writeFileSync(outputPath, `${adapted.map((row) => JSON.stringify(row)).join("\n")}\n`);
	const observations = adapted.filter((row) => row.kind === "observation");
	const byArm = new Map();
	for (const row of observations) {
		if (!byArm.has(row.arm)) byArm.set(row.arm, { messages: 0, findings: 0 });
		const entry = byArm.get(row.arm);
		entry.messages += 1;
		entry.findings += row.findingCount;
	}
	process.stderr.write(`${observations.length} delivered messages from ${byArm.size} arms\n`);
	for (const [arm, entry] of [...byArm.entries()].sort()) {
		process.stderr.write(
			`  ${arm.padEnd(6)} ${entry.messages} messages, ${entry.findings} emitted findings (${(entry.findings / entry.messages).toFixed(2)}/message)\n`,
		);
	}
}
