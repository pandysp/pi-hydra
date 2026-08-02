#!/usr/bin/env node
/** Render the registered comparison table while allowing quality to stay blank until Opus arrives. */

import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const pct = (found, total) => `${found}/${total} (${((found / (total || 1)) * 100).toFixed(1)}%)`;
const money = (value) => (typeof value === "number" ? `$${value.toFixed(4)}` : "—");
const percent = (value) => (typeof value === "number" ? `${value.toFixed(1)}%` : "—");

function qualityOf(row) {
	if (!row.blocking || !row.harmful || !row.precision) {
		return { blocking: "—", anyHarm: "—", precision: "—", noise: "—", quiet: "—", weighted: "—" };
	}
	const anyFound = row.blocking.found + row.harmful.found;
	const anyTotal = row.blocking.total + row.harmful.total;
	const weightedFound = 2 * row.blocking.found + row.harmful.found;
	const weightedTotal = 2 * row.blocking.total + row.harmful.total;
	const derivedNoise = row.precision.raised - row.precision.real;
	if (row.absoluteNoise !== undefined && row.absoluteNoise !== derivedNoise) {
		throw new Error(`${row.task}/${row.config}/${row.arm}: absoluteNoise disagrees with precision counts`);
	}
	return {
		blocking: pct(row.blocking.found, row.blocking.total),
		anyHarm: pct(anyFound, anyTotal),
		precision: pct(row.precision.real, row.precision.raised),
		noise: String(derivedNoise),
		quiet: String(row.quietSpanDeliveries ?? 0),
		weighted: pct(weightedFound, weightedTotal),
	};
}

export function renderCapstoneTable(input) {
	if (!Array.isArray(input.rows)) throw new Error("comparison input requires rows[]");
	const lines = [
		`Dataset: ${input.datasetVersion ?? "pending frozen v2"}. Quality cells marked — are intentionally unscored.`,
		"",
		"| task | config | arm | cost / observation | observer / driver | blocking recall | any-harm recall | precision | absolute noise | quiet-span deliveries | weighted recall* |",
		"|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
	];
	for (const row of input.rows) {
		for (const key of ["task", "config", "arm"]) if (!row[key]) throw new Error(`comparison row missing ${key}`);
		const q = qualityOf(row);
		lines.push(
			`| ${row.task} | ${row.config} | ${row.arm} | ${money(row.costPerObservation)} | ${percent(row.observerDriverPercent)} | ${q.blocking} | ${q.anyHarm} | ${q.precision} | ${q.noise} | ${q.quiet} | ${q.weighted} |`,
		);
	}
	lines.push("", "\\* Convenience value only: blockers count twice; quality and cost remain separate.");
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
