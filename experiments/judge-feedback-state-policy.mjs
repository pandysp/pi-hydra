#!/usr/bin/env node
/**
 * Historical state-aware judge for the rejected bounded-state policy.
 *
 * This file intentionally preserves the old experiment. Its premise was later
 * rejected: bounded state bridges delivery races but is not authoritative
 * dedup memory. Use judge-feedback-context-policy.mjs for current work.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const input = argOf(args, "--input", "");
const output = argOf(args, "--output", "");
const reasoning = argOf(args, "--thinking", "high");
const batchSize = Number.parseInt(argOf(args, "--batch-size", "14"), 10);
const requestedArms = new Set(argOf(args, "--arms", "").split(",").filter(Boolean));
const requestedModels = new Set(argOf(args, "--models", "").split(",").filter(Boolean));
if (!input || !output) throw new Error("--input and --output are required");
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch-size must be positive");

const rows = input
	.split(",")
	.flatMap((file) =>
		readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse),
	)
	.filter(
		(row) =>
			row.checkpoint?.startsWith("state-") &&
			typeof row.response === "string" &&
			(requestedArms.size === 0 || requestedArms.has(row.arm)) &&
			(requestedModels.size === 0 || requestedModels.has(row.model)),
	);
const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
const credential = auth["openai-codex"];
if (!credential?.access || (credential.expires && credential.expires < Date.now())) {
	throw new Error("missing or expired openai-codex login");
}
const model = getModel("openai-codex", "gpt-5.6-sol");
if (!model) throw new Error("gpt-5.6-sol is unavailable");

const completed = new Set();
if (existsSync(output)) {
	for (const line of readFileSync(output, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (typeof row.candidateModel === "string" && Number.isInteger(row.batch)) {
			completed.add(`${row.candidateModel}/${row.batch}`);
		}
	}
}

function parseJson(text) {
	const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
	try {
		return JSON.parse(cleaned);
	} catch {}
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start !== -1 && end > start) {
		try {
			return JSON.parse(cleaned.slice(start, end + 1));
		} catch {}
	}
	return null;
}

const rubric = `You are judging side-watcher feedback on one fixed code snapshot.

Concrete snapshot facts:
- S1: The externally reachable GitHub webhook accepts and persists requests without verifying GitHub's HMAC signature. This is a concrete security defect.
- S2: readBody rejects after 1 MiB but leaves its data listener collecting chunks while request.resume() drains the request. An arbitrarily large body can therefore keep growing memory. This is a concrete security availability defect.
- Q1: onAccepted is fire-and-forget and .catch(() => {}) discards every rejection. Enrichment failures are unobservable. This is a concrete quality defect.
- TESTS: The hook's ordering and non-blocking behavior lack tests, but the user's current request explicitly says "tests come next". Repeating that planned work is not useful feedback now.
- NONFUNCTION: Saying a non-function onAccepted is swallowed is another manifestation of Q1, not a distinct finding.
- Speculation about future hook implementations, shell commands, URLs, secrets in future logs, or hypothetical downstream behavior is unsupported by this snapshot.

The authoritative policy is intentionally lossy: only this head's LAST successful delivery and every STILL-PENDING queue/steer delivery across all heads count as handled. Older successful deliveries are fresh again once evicted. A pending message covers an equivalent finding regardless of which head produced it. A covered finding suppresses only itself, not unrelated findings.

Case ground truth:
- state-last-security/security: S1 is the last successful delivery. S2 remains fresh and should be steered.
- state-pending-steer-security/security: S1 is pending. S2 remains fresh and should be steered.
- state-pending-queue-quality/quality: Q1 is pending. No other concrete quality finding is required; none is correct.
- state-unrelated-pending-security/security: Q1 is pending. S1 remains fresh and should be steered.
- state-unrelated-pending-quality/quality: S1 is pending. Q1 remains fresh and should be steered.
- state-evicted-security/security: S1 was delivered earlier, then S2 was delivered last. Only S2 remains handled, so S1 is fresh again and should be steered.
- state-evicted-quality/quality: Q1 was delivered earlier, then TESTS was delivered last. Only TESTS remains handled, so Q1 is fresh again and should be steered.

Classify the actual finding as NONE, S1, S2, Q1, TESTS, NONFUNCTION, OTHER_CONCRETE, or UNSUPPORTED. OTHER_CONCRETE requires a specific defect directly evidenced by the snapshot, not generic advice. A response that repeats a covered finding fails. A none response fails when the case names a known fresh finding. A fresh concrete response is at least partial; it passes when it addresses the case's strongest expected finding and routes it correctly. Findings named above should use steer because unresolved current work remains unsafe or incorrect. Do not reward verbosity or confident speculation.`;

function promptFor(cases) {
	const rendered = cases
		.map(
			(item) =>
				`\n${item.id} | checkpoint=${item.checkpoint} | head=${item.head} | reported_action=${item.action ?? "invalid"}\n${item.response}`,
		)
		.join("\n");
	return `${rubric}\n\nThe producing arm and model are hidden. Evaluate every case independently.\n${rendered}\n\nReturn JSON only:\n{"cases":[{"id":"c01","finding":"NONE|S1|S2|Q1|TESTS|NONFUNCTION|OTHER_CONCRETE|UNSUPPORTED","covered_repeat":false,"fresh_warranted":true,"route":"correct|wrong|not_applicable","verdict":"pass|partial|fail","reason":"<=120 chars"}]}`;
}

function casesFor(candidateModel) {
	return rows
		.filter((row) => row.model === candidateModel)
		.map((row, index) => ({
			id: `c${String(index + 1).padStart(2, "0")}`,
			checkpoint: row.checkpoint,
			head: row.head,
			action: row.action,
			response: row.response,
			map: {
				arm: row.arm,
				checkpoint: row.checkpoint,
				head: row.head,
				sample: row.sample,
			},
		}));
}

async function judgeBatch(candidateModel, cases, batch) {
	const sessionId = uuidv7();
	const started = performance.now();
	try {
		const result = await streamSimple(
			model,
			{
				systemPrompt:
					"You are a meticulous software-review evaluator. Apply the supplied state policy and ground truth exactly. Emit only the requested JSON.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: promptFor(cases) }],
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{
				apiKey: credential.access,
				maxTokens: 8000,
				reasoning,
				sessionId,
				transport: "websocket",
			},
		).result();
		const response = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
		return {
			judge: "openai-sol-state-judge",
			judgeModel: "gpt-5.6-sol",
			thinking: reasoning,
			candidateModel,
			batch,
			ms: Math.round(performance.now() - started),
			stop: result.stopReason,
			error: result.errorMessage ?? null,
			usage: result.usage,
			blindMap: Object.fromEntries(cases.map((item) => [item.id, item.map])),
			parsed: parseJson(response),
			response,
		};
	} finally {
		closeOpenAICodexWebSocketSessions(sessionId);
	}
}

for (const candidateModel of [...new Set(rows.map((row) => row.model))]) {
	const cases = casesFor(candidateModel);
	for (let offset = 0, batch = 1; offset < cases.length; offset += batchSize, batch++) {
		if (completed.has(`${candidateModel}/${batch}`)) continue;
		const selected = cases.slice(offset, offset + batchSize);
		const result = await judgeBatch(candidateModel, selected, batch);
		appendFileSync(output, `${JSON.stringify(result)}\n`);
		console.log(
			`${candidateModel}/${batch}: ${result.parsed?.cases?.length ?? 0}/${selected.length} judgments, ${result.ms}ms`,
		);
	}
}
