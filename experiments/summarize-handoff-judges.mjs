#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const input = argOf(args, "--input", "");
const qualityInput = argOf(args, "--quality-input", "");
const arms = argOf(args, "--arms", "current,split").split(",").filter(Boolean);
if (!input || !qualityInput) throw new Error("--input and --quality-input are required");
if (arms.length !== 2) throw new Error("--arms requires exactly two comma-separated arms");
const records = input.split(",").flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const quality = qualityInput.split(",").flatMap((file) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse));
const modelProvider = Object.fromEntries(quality.map((row) => [row.model, row.provider]));
const dimensions = ["accuracy", "specificity", "usefulness", "restraint"];

const verdicts = [];
for (const record of records) {
	for (const pair of record.parsed?.pairs ?? []) {
		const map = record.blindMap[pair.id];
		if (!map) continue;
		const winner = pair.winner === "tie" ? "tie" : map[pair.winner];
		for (const label of ["A", "B"]) {
			const arm = map[label];
			const scores = pair[label.toLowerCase()] ?? {};
			verdicts.push({
				judge: record.judge,
				candidateModel: record.candidateModel,
				candidateProvider: modelProvider[record.candidateModel],
				pair: pair.id,
				arm,
				winner,
				scores,
			});
		}
	}
}

function summarize(group) {
	const pairRows = group.filter((row) => row.arm === arms[0]);
	return {
		pairs: pairRows.length,
		firstWins: pairRows.filter((row) => row.winner === arms[0]).length,
		secondWins: pairRows.filter((row) => row.winner === arms[1]).length,
		ties: pairRows.filter((row) => row.winner === "tie").length,
		scores: Object.fromEntries(arms.map((arm) => {
			const selected = group.filter((row) => row.arm === arm);
			return [arm, Object.fromEntries(dimensions.map((dimension) => [
				dimension,
				selected.length ? selected.reduce((sum, row) => sum + (Number(row.scores[dimension]) || 0), 0) / selected.length : null,
			]))];
		})),
	};
}

function grouped(keys) {
	const groups = new Map();
	for (const row of verdicts) {
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

const byPair = new Map();
for (const row of verdicts.filter((row) => row.arm === arms[0])) {
	const key = `${row.candidateModel}/${row.pair}`;
	const values = byPair.get(key) ?? [];
	values.push(row.winner);
	byPair.set(key, values);
}
const comparable = [...byPair.values()].filter((values) => values.length === 2);
const result = {
	records: records.length,
	parsedRecords: records.filter((record) => Array.isArray(record.parsed?.pairs)).length,
	overall: summarize(verdicts),
	byJudge: grouped(["judge"]),
	byCandidateProvider: grouped(["candidateProvider"]),
	byCandidateModel: grouped(["candidateProvider", "candidateModel"]),
	judgeAgreement: {
		pairs: comparable.length,
		exact: comparable.filter(([a, b]) => a === b).length,
		percent: comparable.length ? comparable.filter(([a, b]) => a === b).length / comparable.length * 100 : null,
	},
};

if (process.argv.includes("--json")) {
	console.log(JSON.stringify(result, null, 2));
} else {
	console.log(["scope", "pairs", arms[0], arms[1], "ties", ...dimensions.flatMap((name) => [`a-${name}`, `b-${name}`])].join("\t"));
	for (const row of [{ scope: "overall", ...result.overall }, ...result.byJudge.map((entry) => ({ scope: entry.judge, ...entry }))]) {
		console.log([
			row.scope, row.pairs, row.firstWins, row.secondWins, row.ties,
			...dimensions.flatMap((name) => [row.scores[arms[0]][name]?.toFixed(2) ?? "-", row.scores[arms[1]][name]?.toFixed(2) ?? "-"]),
		].join("\t"));
	}
	console.log(`judge agreement\t${result.judgeAgreement.exact}/${result.judgeAgreement.pairs}\t${result.judgeAgreement.percent?.toFixed(1) ?? "-"}%`);
}
