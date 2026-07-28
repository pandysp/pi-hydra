#!/usr/bin/env node
/** Aggregate the frozen delivery-context A/B and its blind judgments. */

import { readFileSync } from "node:fs";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const inputPaths = argOf(args, "--input", "").split(",").filter(Boolean);
const judgePaths = argOf(args, "--judges", "").split(",").filter(Boolean);
const jsonOutput = args.includes("--json");
if (inputPaths.length === 0) throw new Error("--input is required");

const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
const rows = inputPaths.flatMap(readJsonl);
const judgments = judgePaths.flatMap(readJsonl);

function quantile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
	return sorted[index];
}

function mean(values) {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(values) {
	return values.length === 0 ? null : values.filter(Boolean).length / values.length;
}

function round(value, digits = 3) {
	return value === null ? null : Number(value.toFixed(digits));
}

const judgmentBySource = new Map();
for (const judgment of judgments) {
	const list = judgmentBySource.get(judgment.sourceKey) ?? [];
	list.push(judgment);
	judgmentBySource.set(judgment.sourceKey, list);
}

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

function groupKey(row) {
	return `${row.provider ?? "unknown"}/${row.model}/${row.arm}`;
}

const waitingCategories = new Set([
	"pending-equivalent",
	"newly-delivered-no-response",
	"visible-no-response",
	"full-resolution",
]);
const followupCategories = new Set(["explicit-rejection", "material-change", "older-visible-rejection", "partial-resolution"]);

function summarizeGroup(group) {
	const valid = group.filter((row) => row.completionValid);
	const judged = group.flatMap((row) => judgmentBySource.get(sourceKey(row)) ?? []);
	const allJudges = (row, predicate) => {
		const items = judgmentBySource.get(sourceKey(row)) ?? [];
		return items.length > 0 && items.every(predicate);
	};
	const semanticallyCorrect = (item) =>
		item.support >= 3 && item.target >= 3 && item.context >= 3 && item.route >= 3 && item.verdict !== "fail";
	const semanticCorrect = group.filter((row) => {
		const itemJudges = judgmentBySource.get(sourceKey(row)) ?? [];
		return itemJudges.length > 0 && itemJudges.every(semanticallyCorrect);
	});
	const feedbackRows = valid.filter((row) => row.expectedDelivery !== "none");
	const waitingRows = valid.filter((row) => waitingCategories.has(row.category));
	const followupRows = valid.filter((row) => followupCategories.has(row.category));
	const unrelatedRows = valid.filter((row) => row.category === "pending-unrelated");
	const criticalRows = group.filter((row) => row.critical);
	return {
		n: group.length,
		valid: round(rate(group.map((row) => row.completionValid))),
		oneCall: round(rate(valid.map((row) => row.providerCalls === 1))),
		recovery: round(rate(valid.map((row) => row.recoveryAttempted))),
		deliveryCorrect: round(rate(valid.map((row) => row.deliveryCorrect))),
		feedbackRequiredCorrect: round(rate(valid.filter((row) => row.expectedDelivery !== "none").map((row) => row.deliveryCorrect))),
		waitingCorrect: round(rate(valid.filter((row) => waitingCategories.has(row.category)).map((row) => row.deliveryCorrect))),
		followupCorrect: round(rate(valid.filter((row) => followupCategories.has(row.category)).map((row) => row.deliveryCorrect))),
		unrelatedPendingCorrect: round(rate(valid.filter((row) => row.category === "pending-unrelated").map((row) => row.deliveryCorrect))),
		feedbackRequiredSemantic: judged.length === 0 ? null : round(rate(feedbackRows.map((row) => allJudges(row, semanticallyCorrect)))),
		waitingSemantic: judged.length === 0
			? null
			: round(rate(waitingRows.map((row) => allJudges(row, (item) => item.context >= 3 && item.verdict !== "fail")))),
		followupSemantic: judged.length === 0 ? null : round(rate(followupRows.map((row) => allJudges(row, semanticallyCorrect)))),
		unrelatedPendingSemantic: judged.length === 0 ? null : round(rate(unrelatedRows.map((row) => allJudges(row, semanticallyCorrect)))),
		criticalSemantic: judged.length === 0 ? null : round(rate(criticalRows.map((row) => allJudges(row, semanticallyCorrect)))),
		routeSemantic: judged.length === 0
			? null
			: round(rate(valid.map((row) => allJudges(row, (item) => item.route >= 3 && item.verdict !== "fail")))),
		falseInterrupts: valid.filter((row) => row.delivery === "interrupt" && row.expectedDelivery !== "interrupt").length,
		genuineInterrupt: round(rate(valid.filter((row) => row.expectedDelivery === "interrupt").map((row) => row.delivery === "interrupt"))),
		runtimeSuppressed: valid.filter((row) => row.runtimeSuppressed).length,
		latencyMedianMs: quantile(valid.map((row) => row.ms), 0.5),
		latencyP95Ms: quantile(valid.map((row) => row.ms), 0.95),
		costMean: round(mean(valid.map((row) => row.usage?.cost ?? 0)), 6),
		cacheHitMean: round(mean(valid.map((row) => row.hitRatio ?? 0)), 2),
		zeroCacheReads: valid.filter((row) => (row.usage?.cacheRead ?? 0) === 0).length,
		judgeN: judged.length,
		judgeScoreMean: round(mean(judged.map((item) => item.total)), 2),
		judgeFailureRate: round(rate(judged.map((item) => item.verdict === "fail"))),
		judgeDisputes: judged.filter((item) => item.gold_disputed).length,
		semanticCorrect: judged.length === 0 ? null : round(semanticCorrect.length / group.length),
	};
}

const groups = {};
for (const key of [...new Set(rows.map(groupKey))].sort()) {
	groups[key] = summarizeGroup(rows.filter((row) => groupKey(row) === key));
}

const pairwise = {};
for (const judge of [...new Set(judgments.map((item) => item.judge))].sort()) {
	const judgeRows = judgments.filter((item) => item.judge === judge);
	const index = new Map(judgeRows.map((item) => [`${item.model}/${item.case}/${item.sample}/${item.arm}`, item]));
	const arms = [...new Set(judgeRows.map((item) => item.arm))].sort();
	for (let leftIndex = 0; leftIndex < arms.length; leftIndex++) {
		for (let rightIndex = leftIndex + 1; rightIndex < arms.length; rightIndex++) {
			const leftArm = arms[leftIndex];
			const rightArm = arms[rightIndex];
			let left = 0;
			let right = 0;
			let tie = 0;
			for (const item of judgeRows.filter((row) => row.arm === leftArm)) {
				const other = index.get(`${item.model}/${item.case}/${item.sample}/${rightArm}`);
				if (!other) continue;
				if (item.total > other.total) left++;
				else if (item.total < other.total) right++;
				else tie++;
			}
			if (left + right + tie > 0) {
				pairwise[`${judge}/${leftArm}_vs_${rightArm}`] = { [leftArm]: left, [rightArm]: right, tie };
			}
		}
	}
}

const byProviderArm = {};
for (const provider of [...new Set(rows.map((row) => row.provider).filter(Boolean))].sort()) {
	for (const arm of [...new Set(rows.map((row) => row.arm))].sort()) {
		const selected = rows.filter((row) => row.provider === provider && row.arm === arm);
		if (selected.length > 0) byProviderArm[`${provider}/${arm}`] = summarizeGroup(selected);
	}
}

const result = {
	inputs: inputPaths,
	judges: judgePaths,
	rows: rows.length,
	judgments: judgments.length,
	groups,
	byProviderArm,
	pairwise,
};

if (jsonOutput) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(0);
}

console.log("# Delivery-context golden A/B summary\n");
console.log(`Rows: ${rows.length}; blind judgments: ${judgments.length}.\n`);
console.log("| Provider/model/arm | n | valid | semantic | wait | follow-up | route | median | p95 | cost | cache | judge | fails |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [key, item] of Object.entries(groups)) {
	const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
	console.log(
		`| ${key} | ${item.n} | ${pct(item.valid)} | ${pct(item.feedbackRequiredSemantic ?? item.feedbackRequiredCorrect)} | ${pct(item.waitingSemantic ?? item.waitingCorrect)} | ${pct(item.followupSemantic ?? item.followupCorrect)} | ${pct(item.routeSemantic ?? item.deliveryCorrect)} | ${item.latencyMedianMs ?? "—"}ms | ${item.latencyP95Ms ?? "—"}ms | $${item.costMean ?? "—"} | ${item.cacheHitMean ?? "—"}% | ${item.judgeScoreMean ?? "—"}/20 | ${pct(item.judgeFailureRate)} |`,
	);
}

if (Object.keys(pairwise).length > 0) {
	console.log("\n## Blind pairwise\n");
	for (const [comparison, counts] of Object.entries(pairwise)) {
		console.log(`- ${comparison}: ${Object.entries(counts).map(([key, value]) => `${key} ${value}`).join(", ")}`);
	}
}
