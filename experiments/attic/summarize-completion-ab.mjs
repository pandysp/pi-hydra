#!/usr/bin/env node
/** Summarize completion-protocol review and acting-head JSONL artifacts. */

import { readFileSync } from "node:fs";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const qualityControlPath = argOf(args, "--quality-control", "");
const qualityTreatmentPath = argOf(args, "--quality-treatment", "");
const actingControlPath = argOf(args, "--acting-control", "");
const actingTreatmentPath = argOf(args, "--acting-treatment", "");
const qualityPath = argOf(args, "--quality", "");
const actingPath = argOf(args, "--acting", "");
const arms = argOf(args, "--arms", "json-control,tool-treatment").split(",").filter(Boolean);
if (arms.length !== 2) throw new Error("--arms requires exactly two comma-separated arms");
if (
	(!qualityPath || !actingPath) &&
	(!qualityControlPath || !qualityTreatmentPath || !actingControlPath || !actingTreatmentPath)
) {
	throw new Error(
		"pass --quality and --acting, or all four control/treatment paths",
	);
}

function read(paths) {
	return paths.split(",").flatMap((path) =>
		readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.filter((row) => !row.error),
	);
}

const quality = qualityPath
	? read(qualityPath).filter((row) => arms.includes(row.arm))
	: [
			...read(qualityControlPath).filter((row) => row.arm === arms[0]),
			...read(qualityTreatmentPath).filter((row) => row.arm === arms[1]),
		];
const acting = actingPath
	? read(actingPath).filter((row) => arms.includes(row.arm))
	: [
			...read(actingControlPath).filter((row) => row.arm === arms[0]),
			...read(actingTreatmentPath).filter((row) => row.arm === arms[1]),
		];

function correct(row) {
	// Re-score the immutable tuner artifacts with the corrected semantic
	// predicate. The original runner omitted "never" from its negative-word
	// synonyms, marking one otherwise correct edit in each arm as a failure.
	if (row.case === "tuner-edit-print" && row.filesAfter && row.changedFiles) {
		const security = row.filesAfter["heads/security.md"] ?? "";
		return (
			/naming|style/i.test(security) &&
			/not|never|do not|avoid|exclude|ignore/i.test(security) &&
			row.changedFiles.join(",") === "heads/security.md" &&
			row.action === "print"
		);
	}
	return row.actionCorrect ?? row.correct ?? false;
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function metrics(rows) {
	const input = rows.reduce((sum, row) => sum + (row.usage?.input ?? 0), 0);
	const output = rows.reduce((sum, row) => sum + (row.usage?.output ?? 0), 0);
	const readable = rows.reduce(
		(sum, row) => sum + (row.usage?.input ?? 0) + (row.usage?.cacheRead ?? 0) + (row.usage?.cacheWrite ?? 0),
		0,
	);
	const cacheRead = rows.reduce((sum, row) => sum + (row.usage?.cacheRead ?? 0), 0);
	return {
		n: rows.length,
		valid: rows.filter((row) => row.completionValid).length,
		correct: rows.filter(correct).length,
		calls: rows.reduce((sum, row) => sum + (row.providerCalls ?? 0), 0),
		extra: rows.reduce((sum, row) => sum + (row.extraTurns ?? 0), 0),
		input,
		output,
		cacheRead,
		meanMs: Math.round(rows.reduce((sum, row) => sum + (row.ms ?? 0), 0) / Math.max(1, rows.length)),
		p50Ms: percentile(rows.map((row) => row.ms ?? 0), 0.5),
		p95Ms: percentile(rows.map((row) => row.ms ?? 0), 0.95),
		cache: readable > 0 ? (cacheRead / readable) * 100 : 0,
		zeroCache: rows.filter((row) => (row.usage?.cacheRead ?? 0) === 0).length,
		cost: rows.reduce((sum, row) => sum + (row.usage?.cost ?? 0), 0),
	};
}

function printMetrics(label, rows) {
	console.log(`\n${label}`);
	console.log(
		[
			"arm",
			"n",
			"valid",
			"correct",
			"calls",
			"extra",
			"input",
			"output",
			"cache_read",
			"mean_ms",
			"p50_ms",
			"p95_ms",
			"cache%",
			"zero_cache",
			"cost$",
		].join("\t"),
	);
	for (const arm of arms) {
		const m = metrics(rows.filter((row) => row.arm === arm));
		console.log(
			[
				arm,
				m.n,
				`${m.valid}/${m.n}`,
				`${m.correct}/${m.n}`,
				m.calls,
				m.extra,
				m.input,
				m.output,
				m.cacheRead,
				m.meanMs,
				m.p50Ms,
				m.p95Ms,
				m.cache.toFixed(1),
				`${m.zeroCache}/${m.n}`,
				m.cost.toFixed(4),
			].join("\t"),
		);
	}
}

function paired(rows, fields) {
	const groups = new Map();
	for (const row of rows) {
		const key = fields.map((field) => row[field]).join("/");
		const pair = groups.get(key) ?? {};
		pair[row.arm] = row;
		groups.set(key, pair);
	}
	const complete = [...groups.values()].filter((pair) => arms.every((arm) => pair[arm]));
	return {
		n: complete.length,
		both: complete.filter((pair) => correct(pair[arms[0]]) && correct(pair[arms[1]])).length,
		controlOnly: complete.filter((pair) => correct(pair[arms[0]]) && !correct(pair[arms[1]])).length,
		treatmentOnly: complete.filter((pair) => !correct(pair[arms[0]]) && correct(pair[arms[1]])).length,
		neither: complete.filter((pair) => !correct(pair[arms[0]]) && !correct(pair[arms[1]])).length,
	};
}

printMetrics("review checkpoints", quality);
const reviewPairs = paired(quality, ["model", "thinking", "checkpoint", "head", "sample"]);
console.log(
	`paired review: ${reviewPairs.n} pairs; both ${reviewPairs.both}; control-only ${reviewPairs.controlOnly}; treatment-only ${reviewPairs.treatmentOnly}; neither ${reviewPairs.neither}`,
);

console.log("\nreview accuracy by model/thinking");
console.log(["model", "thinking", "control", "treatment"].join("\t"));
for (const model of [...new Set(quality.map((row) => row.model))].sort()) {
	for (const thinking of ["low", "medium", "high", "xhigh"]) {
		const cells = arms.map((arm) => {
			const rows = quality.filter((row) => row.model === model && row.thinking === thinking && row.arm === arm);
			return `${rows.filter(correct).length}/${rows.length}`;
		});
		console.log([model, thinking, ...cells].join("\t"));
	}
}

console.log("\nreview delivery distribution");
console.log(["arm", "noop", "print", "queue", "steer", "interrupt", "invalid"].join("\t"));
for (const arm of arms) {
	const rows = quality.filter((row) => row.arm === arm);
	console.log(
		[
			arm,
			...["noop", "print", "queue", "steer", "interrupt"].map((action) => rows.filter((row) => row.action === action).length),
			rows.filter((row) => row.action === null).length,
		].join("\t"),
	);
}

printMetrics("acting heads", acting);
const actingPairs = paired(acting, ["model", "thinking", "case", "sample"]);
console.log(
	`paired acting: ${actingPairs.n} pairs; both ${actingPairs.both}; control-only ${actingPairs.controlOnly}; treatment-only ${actingPairs.treatmentOnly}; neither ${actingPairs.neither}`,
);

console.log("\nself-removal");
console.log(["arm", "reliable", "mean_calls", "mean_ms"].join("\t"));
for (const arm of arms) {
	const rows = acting.filter((row) => row.arm === arm && row.case === "foreman-self-remove");
	console.log(
		[
			arm,
			`${rows.filter((row) => row.correct && row.selfRemoved).length}/${rows.length}`,
			(rows.reduce((sum, row) => sum + row.providerCalls, 0) / Math.max(1, rows.length)).toFixed(2),
			Math.round(rows.reduce((sum, row) => sum + row.ms, 0) / Math.max(1, rows.length)),
		].join("\t"),
	);
}
