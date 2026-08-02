#!/usr/bin/env node
/** Resumable, blinded one-Sol diagnostic judge for the fresh OpenAI study. */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { argOf } from "./lib.mjs";
import { flatUsage, pricesFor, rawCost } from "./costing.mjs";
import { gitProvenance } from "./fingerprints.mjs";
import { resolveModel } from "./model-catalog.mjs";
import { OPENAI_PROTOCOL_STUDY_CASES } from "./openai-protocol-study-cases.mjs";
import {
	buildStudyJudgePrompt,
	parseStudyJudgeResponse,
} from "./openai-protocol-study-judge-protocol.mjs";
import { rowKey } from "./openai-protocol-study.mjs";

export const STUDY_JUDGE_SPEC = Object.freeze({
	provider: "openai-codex",
	id: "gpt-5.6-sol",
	reasoning: "xhigh",
	batchSize: 8,
	spendCeilingUsd: 6,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function readProducerRows(path) {
	const all = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const latest = new Map();
	for (const row of all) {
		if (row.kind === "openai-protocol-study-row") latest.set(rowKey(row), row);
	}
	return [...latest.values()].filter((row) => !row.error && Array.isArray(row.findings));
}

export function buildJudgeBatches(rows, batchSize = STUDY_JUDGE_SPEC.batchSize) {
	const cases = new Map(OPENAI_PROTOCOL_STUDY_CASES.map((item) => [item.id, item]));
	const byCase = new Map();
	for (const row of rows) {
		if (!cases.has(row.caseId)) throw new Error(`producer row has unknown case: ${row.caseId}`);
		for (const [findingIndex, finding] of row.findings.entries()) {
			const source = `${rowKey(row)}/${findingIndex}`;
			const candidate = {
				key: `b-${sha256(`openai-protocol-study-v1/${source}`).slice(0, 16)}`,
				reason: finding.reason,
				message: finding.message,
				source: {
					config: row.config,
					caseId: row.caseId,
					sample: row.sample,
					arm: row.arm,
					findingIndex,
					action: finding.action,
				},
			};
			if (!byCase.has(row.caseId)) byCase.set(row.caseId, []);
			byCase.get(row.caseId).push(candidate);
		}
	}
	const batches = [];
	for (const testCase of OPENAI_PROTOCOL_STUDY_CASES) {
		const candidates = (byCase.get(testCase.id) ?? []).sort((a, b) => a.key.localeCompare(b.key));
		for (let start = 0; start < candidates.length; start += batchSize) {
			const part = candidates.slice(start, start + batchSize);
			batches.push({
				id: `${testCase.id}/${String(start / batchSize + 1).padStart(2, "0")}`,
				testCase,
				candidates: part,
			});
		}
	}
	return batches;
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function readExisting(path) {
	if (!existsSync(path)) return { header: null, done: new Set(), spend: 0 };
	const rows = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
	return {
		header: rows.find((row) => row.kind === "openai-protocol-study-judge-header") ?? null,
		done: new Set(rows.filter((row) => row.kind === "openai-protocol-study-judge-batch" && !row.error).map((row) => row.batchId)),
		spend: rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
	};
}

async function judgeBatch({ batch, model, credential, prices }) {
	const visible = batch.candidates.map(({ key, reason, message }) => ({ key, reason, message }));
	const prompt = buildStudyJudgePrompt({ testCase: batch.testCase, candidates: visible });
	const sessionId = uuidv7();
	const started = Date.now();
	try {
		const response = await streamSimple(
			model,
			{
				systemPrompt: "",
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
				tools: [],
			},
			{
				apiKey: credential.access,
				reasoning: STUDY_JUDGE_SPEC.reasoning,
				sessionId,
				transport: "websocket",
			},
		).result();
		const rawResponse = textOf(response);
		const parsed = parseStudyJudgeResponse(
			rawResponse,
			visible.map((item) => item.key),
			new Set(batch.testCase.issues.map((item) => item.id)),
		);
		const usage = flatUsage(response.usage);
		return {
			kind: "openai-protocol-study-judge-batch",
			batchId: batch.id,
			caseId: batch.testCase.id,
			promptHash: sha256(prompt),
			candidates: batch.candidates,
			judgments: parsed.judgments,
			rawResponse,
			parseError: parsed.error,
			usage,
			cost: rawCost(usage, prices),
			stopReason: response.stopReason ?? null,
			error: response.errorMessage ?? parsed.error,
			ms: Date.now() - started,
			ts: Date.now(),
		};
	} finally {
		closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
	const rowsPath = argOf(args, "--rows", "");
	const output = argOf(args, "--output", "");
	const dryRun = args.includes("--dry-run");
	if (!rowsPath || (!dryRun && !output)) throw new Error("--rows and --output are required (output may be omitted with --dry-run)");
	const producerBytes = readFileSync(rowsPath);
	const rows = readProducerRows(rowsPath);
	const batches = buildJudgeBatches(rows);
	const model = resolveModel(STUDY_JUDGE_SPEC.provider, STUDY_JUDGE_SPEC.id);
	if (!model) throw new Error("gpt-5.6-sol is not available");
	const prices = pricesFor(model);
	const header = {
		kind: "openai-protocol-study-judge-header",
		version: 1,
		...gitProvenance(),
		judge: STUDY_JUDGE_SPEC,
		producerRowsSha256: sha256(producerBytes),
		producerRowCount: rows.length,
		candidateCount: batches.reduce((sum, batch) => sum + batch.candidates.length, 0),
		batchIds: batches.map((batch) => batch.id),
		prices,
		ts: Date.now(),
	};
	if (dryRun) {
		process.stdout.write(`${JSON.stringify(header, null, 2)}\n`);
		process.exit(0);
	}

	const authFile = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
	const credential = authFile[STUDY_JUDGE_SPEC.provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error("missing or expired openai-codex login; run pi and log in first");
	}
	const existing = readExisting(output);
	if (existing.header) {
		const withoutTs = ({ ts: _ts, ...rest }) => rest;
		if (JSON.stringify(withoutTs(existing.header)) !== JSON.stringify(withoutTs(header))) {
			throw new Error(`${output} judge header drifted`);
		}
	} else if (existsSync(output)) {
		throw new Error(`${output} exists without a judge header`);
	} else {
		appendFileSync(output, `${JSON.stringify(header)}\n`);
	}

	let spend = existing.spend;
	let errors = 0;
	for (const batch of batches) {
		if (existing.done.has(batch.id)) continue;
		if (spend >= STUDY_JUDGE_SPEC.spendCeilingUsd) throw new Error(`judge spend ceiling reached at $${spend.toFixed(4)}`);
		let row;
		try {
			row = await judgeBatch({ batch, model, credential, prices });
			errors = row.error ? errors + 1 : 0;
		} catch (error) {
			errors++;
			row = {
				kind: "openai-protocol-study-judge-batch",
				batchId: batch.id,
				caseId: batch.testCase.id,
				candidates: batch.candidates,
				error: error instanceof Error ? error.message : String(error),
				ts: Date.now(),
			};
		}
		appendFileSync(output, `${JSON.stringify(row)}\n`);
		spend += row.cost ?? 0;
		process.stderr.write(`${batch.id}: ${row.error ? `ERROR ${row.error}` : `${row.judgments.length} judged, $${row.cost.toFixed(4)}`}\n`);
		if (errors >= 3) throw new Error("three consecutive judge errors; stopping");
	}
	appendFileSync(output, `${JSON.stringify({ kind: "openai-protocol-study-judge-end", spend, ts: Date.now() })}\n`);
}
