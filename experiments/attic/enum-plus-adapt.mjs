#!/usr/bin/env node
/**
 * Adapts ENUM+ probe rows into the shape `severity-pool-probe-v2.mjs` consumes,
 * so the resolved metric (blocking / anyHarm, `SEVERITY-V4-BLOCKING-TIER.md`)
 * scores this run with no change to the judging pipeline.
 *
 * Two conversions, both necessary:
 *
 * 1. `kind:"skip-probe"` + `variantId` -> `kind:"observation"` + `arm`. The
 *    probe replays arbitrary prompt strings, so its rows carry a variant id
 *    where the trajectory runner carries an arm.
 *
 * 2. **Format normalisation, and this one is load-bearing.** ENUM and ENUM+D
 *    answer with a `findings` ARRAY; MAIN answers with a single `message`
 *    string; F2 answers with prose plus a DELIVERY footer. `messageTextOf`
 *    falls through to RAW TEXT for an array, so without this the judge would
 *    read clean prose from two arms and raw JSON from two others — format
 *    leakage into a blind comparison. Every arm is rendered as prose here: an
 *    enumerated answer becomes its findings joined one per line.
 *
 * `file-state` rows come from the pilot trajectory the payloads were recorded
 * from, because `codeContext` needs both ends of the session and probe rows
 * carry no file state.
 *
 * Usage:
 *   node experiments/attic/enum-plus-adapt.mjs --probe rows.jsonl \
 *     --trajectory <pilot rows.jsonl> --output adapted.jsonl
 */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "../lib.mjs";

/** Prose for any of the three answer shapes. Exported so the check can pin it. */
export function normalizeText(responseText) {
	const raw = String(responseText ?? "").trim();
	if (raw === "") return "";
	if (/DELIVERY:\s*\w+\s*$/i.test(raw)) return raw.replace(/\s*DELIVERY:\s*\w+\s*$/i, "").trim();
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed?.findings)) {
			return parsed.findings
				.map((finding) => String(finding?.message ?? "").trim())
				.filter(Boolean)
				.join("\n");
		}
		if (typeof parsed?.message === "string") return parsed.message.trim();
	} catch {
		/* not JSON: the raw text is the message */
	}
	return raw;
}

/** How many distinct findings the arm actually emitted (P4 shape). */
export function findingCount(responseText) {
	const raw = String(responseText ?? "").trim();
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed?.findings)) return parsed.findings.filter((f) => String(f?.message ?? "").trim()).length;
		if (typeof parsed?.message === "string") return parsed.message.trim() === "" ? 0 : 1;
	} catch {
		/* fall through */
	}
	if (/DELIVERY:\s*none\s*$/i.test(raw)) return 0;
	return raw === "" ? 0 : 1;
}

export function adapt(probeRows, trajectoryRows) {
	const observations = probeRows
		.filter((row) => row.kind === "skip-probe" && !row.error)
		.filter((row) => row.delivery && row.delivery !== "none")
		.map((row) => ({
			...row,
			kind: "observation",
			arm: row.variantId,
			// The probe replays ONE point, so `pointIndex` is constant; the sample
			// index is what orders these rows. Keep both, and let sample drive order
			// so the pipeline's sort is stable and meaningful.
			pointIndex: row.sample,
			probePointIndex: row.pointIndex,
			responseText: normalizeText(row.responseText),
			rawResponseText: row.responseText,
			findingCount: findingCount(row.responseText),
			valid: true,
		}));
	const fileStates = trajectoryRows.filter((row) => row.kind === "file-state");
	if (fileStates.length === 0) throw new Error("trajectory carries no file-state rows: codeContext would throw");
	return [...fileStates, ...observations];
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const probePath = argOf(args, "--probe", "");
	const trajectoryPath = argOf(args, "--trajectory", "");
	const outputPath = argOf(args, "--output", "");
	if (!probePath || !trajectoryPath || !outputPath) throw new Error("--probe, --trajectory and --output are required");
	const read = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const rows = adapt(read(probePath), read(trajectoryPath));
	writeFileSync(outputPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	const observations = rows.filter((row) => row.kind === "observation");
	const byArm = new Map();
	for (const row of observations) {
		if (!byArm.has(row.arm)) byArm.set(row.arm, { messages: 0, findings: 0 });
		const entry = byArm.get(row.arm);
		entry.messages += 1;
		entry.findings += row.findingCount;
	}
	process.stderr.write(`${observations.length} delivered messages from ${byArm.size} arms\n`);
	for (const [arm, entry] of [...byArm.entries()].sort()) {
		process.stderr.write(`  ${arm.padEnd(7)} ${entry.messages} messages, ${entry.findings} emitted findings (${(entry.findings / entry.messages).toFixed(2)}/message)\n`);
	}
}
