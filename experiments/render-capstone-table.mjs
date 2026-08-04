#!/usr/bin/env node
/** Render the registered comparison table while allowing quality to stay blank until Opus arrives. */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const pct = (found, total) => `${found}/${total} (${((found / (total || 1)) * 100).toFixed(1)}%)`;
const money = (value) => (typeof value === "number" ? `$${value.toFixed(4)}` : "—");
const percent = (value) => (typeof value === "number" ? `${value.toFixed(1)}%` : "—");

function qualityOf(row) {
	if (!row.blocking || !row.harmful || !row.precision) {
		return { blocking: "—", anyHarm: "—", precision: "—", precisionValid: "—", noise: "—", floor: "—", quiet: "—", weighted: "—" };
	}
	const anyFound = row.blocking.found + row.harmful.found;
	const anyTotal = row.blocking.total + row.harmful.total;
	const weightedFound = 2 * row.blocking.found + row.harmful.found;
	const weightedTotal = 2 * row.blocking.total + row.harmful.total;
	// The registered noise reading is the both-judges-not-real count
	// (BENCHMARK-SPEC), which legitimately differs from raised − real; the
	// producer supplies it as absoluteNoise. raised − real stays derivable
	// from the precision cell itself.
	if (row.absoluteNoise !== undefined && (!Number.isInteger(row.absoluteNoise) || row.absoluteNoise < 0 || row.absoluteNoise > row.precision.raised)) {
		throw new Error(`${row.task}/${row.config}/${row.arm}: absoluteNoise out of range`);
	}
	const noise = row.absoluteNoise !== undefined ? row.absoluteNoise : row.precision.raised - row.precision.real;
	return {
		blocking: pct(row.blocking.found, row.blocking.total),
		anyHarm: pct(anyFound, anyTotal),
		precision: pct(row.precision.real, row.precision.raised),
		precisionValid: row.precisionValid ? pct(row.precisionValid.real, row.precisionValid.raised) : "—",
		noise: String(noise),
		floor: row.oneJudgeFloor ? `${row.oneJudgeFloor.count} (${row.oneJudgeFloor.blocking}b)` : "—",
		quiet: String(row.quietSpanDeliveries ?? 0),
		weighted: pct(weightedFound, weightedTotal),
	};
}

export function renderCapstoneTable(input) {
	if (!Array.isArray(input.rows)) throw new Error("comparison input requires rows[]");
	const lines = [
		`Dataset: ${input.datasetVersion ?? "pending frozen v2"}. Quality cells marked — are intentionally unscored.`,
		"",
		"| task | config | arm | cost / observation | observer / driver | blocking recall | any-harm recall | precision | precision (valid-only) | absolute noise | one-judge floor | quiet-span deliveries | weighted recall* |",
		"|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const row of input.rows) {
		for (const key of ["task", "config", "arm"]) if (!row[key]) throw new Error(`comparison row missing ${key}`);
		const q = qualityOf(row);
		lines.push(
			`| ${row.task} | ${row.config} | ${row.arm} | ${money(row.costPerObservation)} | ${percent(row.observerDriverPercent)} | ${q.blocking} | ${q.anyHarm} | ${q.precision} | ${q.precisionValid} | ${q.noise} | ${q.floor} | ${q.quiet} | ${q.weighted} |`,
		);
	}
	lines.push(
		"",
		"\\* Convenience value only: blockers count twice; quality and cost remain separate.",
		"Absolute noise is the registered both-judges-not-real count. The one-judge floor counts active catalog ids matched by exactly one judge (blocking subcount in parentheses) — the credit rule's cost, recorded without changing the rule.",
	);
	return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const path = argOf(process.argv.slice(2), "--input", "");
	if (!path) throw new Error("--input <comparison.json> is required");
	const rendered = renderCapstoneTable(JSON.parse(readFileSync(path, "utf8")));
	const output = argOf(process.argv.slice(2), "--output", "");
	if (output) writeFileSync(output, rendered);
	else process.stdout.write(rendered);
}
