#!/usr/bin/env node
/** Aggregate delivery-context A/B/C rows and narrow blind judgments. */

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
const judgeNames = [...new Set(judgments.map((item) => item.judge))].sort();
const requiredJudges = ["opus", "sol"];
const requiredJudgeSetComplete = requiredJudges.every((judge) => judgeNames.includes(judge));

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

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

function groupKey(row) {
	return `${row.provider ?? "unknown"}/${row.model}/${row.arm}`;
}

const judgmentIndex = new Map();
for (const judgment of judgments) {
	const key = `${judgment.sourceKey}/${judgment.metric}`;
	const list = judgmentIndex.get(key) ?? [];
	list.push(judgment);
	judgmentIndex.set(key, list);
}

function metricJudgments(row, metric) {
	return judgmentIndex.get(`${sourceKey(row)}/${metric}`) ?? [];
}

function unanimous(row, metric, answer) {
	const items = metricJudgments(row, metric).filter((item) => requiredJudges.includes(item.judge));
	return (
		requiredJudgeSetComplete &&
		items.length === requiredJudges.length &&
		new Set(items.map((item) => item.judge)).size === requiredJudges.length &&
		items.every((item) => item.answer === answer)
	);
}

function findingQuality(row) {
	if (!requiredJudgeSetComplete) return null;
	if (row.delivery === "none") return false;
	return unanimous(row, "support", true) && unanimous(row, "target", true);
}

function avoidsImproperRepeat(row) {
	if (!requiredJudgeSetComplete) return null;
	if (row.delivery === "none") return true;
	return unanimous(row, "repeat", false);
}

const waitingCategories = new Set([
	"pending-equivalent",
	"newly-delivered-no-response",
	"visible-no-response",
	"full-resolution",
]);
const followupCategories = new Set(["explicit-rejection", "material-change", "older-visible-rejection", "partial-resolution"]);

function confusionMatrix(group) {
	const matrix = {};
	for (const row of group.filter((item) => item.completionValid)) {
		const key = `${row.expectedDelivery}->${row.delivery}`;
		matrix[key] = (matrix[key] ?? 0) + 1;
	}
	return matrix;
}

function summarizeGroup(group) {
	const valid = group.filter((row) => row.completionValid);
	const feedbackRows = valid.filter((row) => row.expectedDelivery !== "none");
	const noFeedbackRows = valid.filter((row) => row.expectedDelivery === "none");
	const waitingRows = valid.filter((row) => waitingCategories.has(row.category));
	const followupRows = valid.filter((row) => followupCategories.has(row.category));
	const unrelatedRows = valid.filter((row) => row.category === "pending-unrelated");
	const supportItems = feedbackRows
		.flatMap((row) => metricJudgments(row, "support"))
		.filter((item) => requiredJudges.includes(item.judge));
	const targetItems = feedbackRows
		.flatMap((row) => metricJudgments(row, "target"))
		.filter((item) => requiredJudges.includes(item.judge));
	const repeatRows = noFeedbackRows.filter((row) => row.delivery !== "none");
	const repeatItems = repeatRows
		.flatMap((row) => metricJudgments(row, "repeat"))
		.filter((item) => requiredJudges.includes(item.judge));
	const expectedJudgments = requiredJudges.length * (feedbackRows.filter((row) => row.delivery !== "none").length * 2 + repeatRows.length);
	const actualJudgments = supportItems.length + targetItems.length + repeatItems.length;
	const agreementSets = [...supportItems, ...targetItems, ...repeatItems].reduce((map, item) => {
		const key = `${item.sourceKey}/${item.metric}`;
		const answers = map.get(key) ?? [];
		answers.push(item.answer);
		map.set(key, answers);
		return map;
	}, new Map());
	const agreement = [...agreementSets.values()].filter((answers) => answers.length === requiredJudges.length);

	return {
		n: group.length,
		valid: round(rate(group.map((row) => row.completionValid))),
		formatValid: round(rate(group.map((row) => row.formatValid))),
		oneCall: round(rate(valid.map((row) => row.providerCalls === 1))),
		recovery: round(rate(valid.map((row) => row.recoveryAttempted))),
		findingQuality: !requiredJudgeSetComplete ? null : round(rate(feedbackRows.map(findingQuality))),
		support: !requiredJudgeSetComplete ? null : round(rate(feedbackRows.map((row) => row.delivery !== "none" && unanimous(row, "support", true)))),
		target: !requiredJudgeSetComplete ? null : round(rate(feedbackRows.map((row) => row.delivery !== "none" && unanimous(row, "target", true)))),
		improperRepeatAvoidance: !requiredJudgeSetComplete ? null : round(rate(noFeedbackRows.map(avoidsImproperRepeat))),
		deliveryBucketCorrect: round(rate(valid.map((row) => row.deliveryCorrect))),
		deliveryExact: round(rate(valid.map((row) => row.deliveryExact ?? row.delivery === row.expectedDelivery))),
		feedbackBucketCorrect: round(rate(feedbackRows.map((row) => row.deliveryCorrect))),
		waitingBucketCorrect: round(rate(waitingRows.map((row) => row.deliveryCorrect))),
		followupQuality: !requiredJudgeSetComplete ? null : round(rate(followupRows.map(findingQuality))),
		unrelatedPendingQuality: !requiredJudgeSetComplete ? null : round(rate(unrelatedRows.map(findingQuality))),
		falseInterrupts: valid.filter((row) => row.delivery === "interrupt" && row.expectedDelivery !== "interrupt").length,
		genuineInterruptExact: round(rate(valid.filter((row) => row.expectedDelivery === "interrupt").map((row) => row.delivery === "interrupt"))),
		runtimeSuppressed: valid.filter((row) => row.runtimeSuppressed).length,
		latencyMedianMs: quantile(valid.map((row) => row.ms), 0.5),
		latencyP95Ms: quantile(valid.map((row) => row.ms), 0.95),
		observerCostMean: round(mean(valid.map((row) => row.usage?.cost ?? 0)), 6),
		cacheHitMean: round(mean(valid.map((row) => row.hitRatio ?? 0)), 2),
		zeroCacheReads: valid.filter((row) => (row.usage?.cacheRead ?? 0) === 0).length,
		judgeCoverage: expectedJudgments === 0 ? null : round(actualJudgments / expectedJudgments),
		judgeAgreement: !requiredJudgeSetComplete || agreement.length === 0
			? null
			: round(rate(agreement.map((answers) => new Set(answers).size === 1))),
		confusion: confusionMatrix(group),
	};
}

const groups = {};
for (const key of [...new Set(rows.map(groupKey))].sort()) {
	groups[key] = summarizeGroup(rows.filter((row) => groupKey(row) === key));
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
	judgeNames,
	requiredJudges,
	requiredJudgeSetComplete,
	rows: rows.length,
	judgments: judgments.length,
	groups,
	byProviderArm,
};

if (jsonOutput) {
	console.log(JSON.stringify(result, null, 2));
	process.exit(0);
}

const pct = (value) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);
console.log("# Delivery-context golden A/B/C summary\n");
console.log(`Rows: ${rows.length}; narrow blind judgments: ${judgments.length}; judges: ${judgeNames.join(", ") || "none"}.\n`);
console.log("| Provider/model/arm | n | quality | observer cost | bucket | exact | repeat restraint | format | median | p95 | cache | judge coverage | agreement |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [key, item] of Object.entries(groups)) {
	console.log(
		`| ${key} | ${item.n} | ${pct(item.findingQuality)} | $${item.observerCostMean ?? "—"} | ${pct(item.deliveryBucketCorrect)} | ${pct(item.deliveryExact)} | ${pct(item.improperRepeatAvoidance)} | ${pct(item.formatValid)} | ${item.latencyMedianMs ?? "—"}ms | ${item.latencyP95Ms ?? "—"}ms | ${item.cacheHitMean ?? "—"}% | ${pct(item.judgeCoverage)} | ${pct(item.judgeAgreement)} |`,
	);
}
