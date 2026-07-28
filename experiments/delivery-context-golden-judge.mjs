#!/usr/bin/env node
/** Narrow blind judging for delivery-context golden A/B/C rows. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { argOf } from "./lib.mjs";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { assertJudgeMetric, buildJudgePrompt, parseBinaryJudgments } from "./delivery-context-judge-protocol.mjs";
import { resolveModel } from "./model-catalog.mjs";

const args = process.argv.slice(2);
const inputPath = argOf(args, "--input", "");
const outputPath = argOf(args, "--output", "");
const judgeName = argOf(args, "--judge", "sol");
const metric = argOf(args, "--metric", "support");
const batchSize = Number.parseInt(argOf(args, "--batch-size", "8"), 10);
const concurrency = Number.parseInt(argOf(args, "--concurrency", "1"), 10);

if (!inputPath || !outputPath) throw new Error("--input and --output are required");
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 12) {
	throw new Error("--batch-size must be between 1 and 12");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
	throw new Error("--concurrency must be between 1 and 8");
}

assertJudgeMetric(metric);

const judgeSpecs = {
	sol: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "high" },
	opus: { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
};
const judgeSpec = judgeSpecs[judgeName];
if (!judgeSpec) throw new Error(`unknown judge: ${judgeName}`);
const judge = resolveModel(judgeSpec.provider, judgeSpec.id);
if (!judge) throw new Error(`judge model unavailable: ${judgeSpec.id}`);

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
const credential = auth[judgeSpec.provider];
if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
	throw new Error(`missing or expired ${judgeSpec.provider} login; run pi and log in first`);
}

const caseById = new Map([...GOLDEN_CASES, ...DEVELOPMENT_CASES].map((item) => [item.id, item]));
const rows = readFileSync(inputPath, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((row) => row.completionValid === true && !row.error);

function sourceKey(row) {
	return `${row.model}/${row.case}/${row.sample}/${row.arm}`;
}

function eligible(row) {
	const testCase = caseById.get(row.case);
	if (!testCase || row.delivery === "none" || !row.message?.trim()) return false;
	return metric === "repeat" ? testCase.expectedDelivery === "none" : testCase.expectedDelivery !== "none";
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		completed.add(`${row.judge}/${row.metric}/${row.sourceKey}`);
	}
}

const pendingRows = rows.filter(
	(row) => eligible(row) && !completed.has(`${judgeName}/${metric}/${sourceKey(row)}`),
);
for (let index = pendingRows.length - 1; index > 0; index--) {
	const other = Math.floor(Math.random() * (index + 1));
	[pendingRows[index], pendingRows[other]] = [pendingRows[other], pendingRows[index]];
}

function promptFor(batch) {
	return buildJudgePrompt(
		metric,
		batch.map((row) => {
		const testCase = caseById.get(row.case);
		if (!testCase) throw new Error(`golden case not found: ${row.case}`);
		return { testCase, message: row.message };
		}),
	);
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

async function judgeBatch(batch) {
	const prompt = promptFor(batch);
	let result = await streamSimple(
		judge,
		{
			systemPrompt: "You are an independent software-review benchmark judge.",
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			tools: [],
		},
		{ apiKey: credential.access, reasoning: judgeSpec.reasoning, maxTokens: 2500 },
	).result();
	let judgments = parseBinaryJudgments(textOf(result), batch.length);
	let recovered = false;
	if (!judgments && !result.errorMessage) {
		recovered = true;
		const correction =
			"Your output did not match the required JSON schema or case count. Preserve every judgment and return only the corrected JSON object.";
		result = await streamSimple(
			judge,
			{
				systemPrompt: "You are an independent software-review benchmark judge.",
				messages: [
					{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
					result,
					{ role: "user", content: [{ type: "text", text: correction }], timestamp: Date.now() },
				],
				tools: [],
			},
			{ apiKey: credential.access, reasoning: judgeSpec.reasoning, maxTokens: 2500 },
		).result();
		judgments = parseBinaryJudgments(textOf(result), batch.length);
	}
	if (!judgments) {
		throw new Error(`judge returned invalid output for ${batch.map(sourceKey).join(", ")}: ${textOf(result).slice(0, 500)}`);
	}

	for (let index = 0; index < batch.length; index++) {
		const source = batch[index];
		const judgment = judgments[index];
		const row = {
			judge: judgeName,
			judgeModel: judge.id,
			judgeThinking: judgeSpec.reasoning,
			metric,
			sourceKey: sourceKey(source),
			case: source.case,
			model: source.model,
			sample: source.sample,
			arm: source.arm,
			recovered,
			...judgment,
		};
		appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
		console.log(`${row.sourceKey}: ${metric}=${row.answer ? "TRUE" : "FALSE"}`);
	}
}

function recordBatchFailure(batch, error) {
	const failure = {
		timestamp: new Date().toISOString(),
		judge: judgeName,
		judgeModel: judge.id,
		judgeThinking: judgeSpec.reasoning,
		metric,
		sourceKeys: batch.map(sourceKey),
		error: error instanceof Error ? error.message : String(error),
	};
	appendFileSync(`${outputPath}.failures.jsonl`, `${JSON.stringify(failure)}\n`);
}

// TODO: Add a separate unwarranted-noise judgment only if finding quality and
// improper-repeat metrics fail to expose economically meaningful noisy sends.

const batches = [];
for (let offset = 0; offset < pendingRows.length; offset += batchSize) {
	batches.push(pendingRows.slice(offset, offset + batchSize));
}
console.error(
	`${pendingRows.length} ${metric} rows to judge with ${judgeName} in batches of ${batchSize}, concurrency ${concurrency}`,
);
let nextBatch = 0;
async function worker() {
	while (nextBatch < batches.length) {
		const index = nextBatch++;
		try {
			await judgeBatch(batches[index]);
		} catch (error) {
			recordBatchFailure(batches[index], error);
			throw error;
		}
	}
}
await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()));
