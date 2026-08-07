#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const input = argOf(args, "--input", "");
if (!input) throw new Error("--input is required");
const rows = input.split(",").flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));

function quantile(values, q) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarize(group) {
	const successful = group.filter((row) => !row.error && row.stop !== "error");
	const parseValid = successful.filter((row) => row.parseValid);
	const expectedSteer = successful.filter((row) => row.expectedAction === "steer");
	const expectedNoop = successful.filter((row) => row.expectedAction === "noop");
	const cost = successful.reduce((sum, row) => sum + (row.usage?.cost?.total ?? 0), 0);
	return {
		calls: group.length,
		apiSuccess: successful.length,
		parseValid: parseValid.length,
		parseRate: successful.length ? parseValid.length / successful.length * 100 : null,
		actionCorrect: successful.filter((row) => row.actionCorrect).length,
		actionAccuracy: successful.length ? successful.filter((row) => row.actionCorrect).length / successful.length * 100 : null,
		steerRecall: expectedSteer.length ? expectedSteer.filter((row) => row.action === "steer").length / expectedSteer.length * 100 : null,
		noopAccuracy: expectedNoop.length ? expectedNoop.filter((row) => row.action === "noop").length / expectedNoop.length * 100 : null,
		p50Ms: quantile(successful.map((row) => row.ms), 0.5),
		p90Ms: quantile(successful.map((row) => row.ms), 0.9),
		cost,
	};
}

function grouped(keys) {
	const groups = new Map();
	for (const row of rows) {
		const key = keys.map((name) => row[name]).join("\t");
		const group = groups.get(key) ?? [];
		group.push(row);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([key, group]) => ({
		...Object.fromEntries(keys.map((name, index) => [name, key.split("\t")[index]])),
		...summarize(group),
	}));
}

function binomialCoefficient(n, k) {
	let value = 1;
	for (let i = 1; i <= k; i++) value = value * (n - i + 1) / i;
	return value;
}

function twoSidedSignP(a, b) {
	const n = a + b;
	if (n === 0) return 1;
	const tail = Math.min(a, b);
	let probability = 0;
	for (let k = 0; k <= tail; k++) probability += binomialCoefficient(n, k) / (2 ** n);
	return Math.min(1, probability * 2);
}

function paired(keys) {
	const cases = new Map();
	for (const row of rows) {
		const caseKey = `${row.model}/${row.checkpoint}/${row.head}/${row.sample}`;
		const pair = cases.get(caseKey) ?? {};
		pair[row.arm] = row;
		cases.set(caseKey, pair);
	}
	const complete = [...cases.values()].filter((pair) => pair.current && pair.split);
	const groups = new Map();
	for (const pair of complete) {
		const key = keys.map((name) => pair.current[name]).join("\t");
		const group = groups.get(key) ?? [];
		group.push(pair);
		groups.set(key, group);
	}
	return [...groups.entries()].map(([key, group]) => {
		const splitOnly = group.filter((pair) => pair.split.actionCorrect && !pair.current.actionCorrect).length;
		const currentOnly = group.filter((pair) => pair.current.actionCorrect && !pair.split.actionCorrect).length;
		return {
			...Object.fromEntries(keys.map((name, index) => [name, key.split("\t")[index]])),
			pairs: group.length,
			bothCorrect: group.filter((pair) => pair.current.actionCorrect && pair.split.actionCorrect).length,
			splitOnly,
			currentOnly,
			neitherCorrect: group.filter((pair) => !pair.current.actionCorrect && !pair.split.actionCorrect).length,
			signTestP: twoSidedSignP(splitOnly, currentOnly),
			meanLatencyDeltaMs: group.reduce((sum, pair) => sum + pair.split.ms - pair.current.ms, 0) / group.length,
			medianLatencyDeltaMs: quantile(group.map((pair) => pair.split.ms - pair.current.ms), 0.5),
		};
	});
}

const result = {
	generatedAt: new Date().toISOString(),
	calls: rows.length,
	arms: grouped(["arm"]),
	providers: grouped(["provider", "arm"]),
	models: grouped(["provider", "model", "arm"]),
	checkpoints: grouped(["provider", "model", "checkpoint", "head", "arm"]),
	pairedOverall: paired([])[0],
	pairedProviders: paired(["provider"]),
	pairedModels: paired(["provider", "model"]),
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(["arm", "calls", "api", "parse%", "action%", "steer%", "noop%", "p50ms", "p90ms", "cost$"].join("\t"));
	for (const row of result.arms) {
		console.log([
			row.arm, row.calls, row.apiSuccess, row.parseRate?.toFixed(1) ?? "-", row.actionAccuracy?.toFixed(1) ?? "-",
			row.steerRecall?.toFixed(1) ?? "-", row.noopAccuracy?.toFixed(1) ?? "-", row.p50Ms ?? "-", row.p90Ms ?? "-", row.cost.toFixed(4),
		].join("\t"));
	}
}
