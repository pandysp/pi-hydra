#!/usr/bin/env node
/**
 * Blind pairwise judge for observer delivery context.
 *
 * Unlike judge-feedback-state-policy.mjs, this judge does not treat delivery
 * state as an automatic suppression rule. It asks whether each observer made
 * a sensible contextual decision: wait, repeat, escalate, update, or report a
 * distinct finding.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { argOf } from "./lib.mjs";

const args = process.argv.slice(2);
const input = argOf(args, "--input", "");
const output = argOf(args, "--output", "");
const reasoning = argOf(args, "--thinking", "high");
const batchSize = Number.parseInt(argOf(args, "--batch-size", "11"), 10);
const controlArm = argOf(
	args,
	"--control",
	"text-message-footer-unified-last-plus-pending-authoritative-compact-recovery-bounded",
);
const treatmentArm = argOf(
	args,
	"--treatment",
	"text-message-footer-unified-last-plus-pending-factual-recovery-bounded",
);
if (!input || !output) throw new Error("--input and --output are required");
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("--batch-size must be positive");

const selected = new Map();
for (const file of input.split(",")) {
	for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (!row.checkpoint?.startsWith("judgment-") || typeof row.response !== "string" || !row.response) continue;
		if (row.arm !== controlArm && row.arm !== treatmentArm) continue;
		const key = [row.model, row.thinking, row.checkpoint, row.head, row.sample, row.arm].join("/");
		selected.set(key, row);
	}
}

const pairMap = new Map();
for (const row of selected.values()) {
	const key = [row.model, row.thinking, row.checkpoint, row.head, row.sample].join("/");
	const pair = pairMap.get(key) ?? { key, rows: new Map() };
	pair.rows.set(row.arm, row);
	pairMap.set(key, pair);
}
const pairs = [...pairMap.values()]
	.filter((pair) => pair.rows.has(controlArm) && pair.rows.has(treatmentArm))
	.sort((a, b) => a.key.localeCompare(b.key));
if (pairs.length === 0) throw new Error("no complete control/treatment pairs found");

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
		if (
			typeof row.candidateModel === "string" &&
			Number.isInteger(row.batch) &&
			Array.isArray(row.parsed?.cases) &&
			row.parsed.cases.length > 0
		) {
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

const rubric = `You are judging two side-watcher responses to the same code trajectory. The producing designs and models are hidden.

The delivery state is factual context, NOT an automatic deduplication rule. The watcher should decide whether waiting, repeating, escalating, updating, or reporting a distinct finding is most useful.

Decision principles:
- If equivalent feedback has just reached the driver and there is no response yet, repeating it is usually noise. A distinct concrete issue can still be useful.
- If equivalent feedback is still pending delivery, repeating it is usually noise unless the response adds a material update or justified escalation.
- If the driver explicitly rejects a still-valid important warning, raising it again is useful. Silence is a contextual failure.
- If the driver fixed the warning, repeating it is wrong. A distinct concrete remaining defect is still useful.
- A materially changed consequence can justify concise follow-up feedback even when it shares the same root cause. Mere rewording cannot.
- Correct silence is better than unsupported or redundant feedback. A known concrete issue is better than generic advice or speculation.
- Judge the response under its named lens. Prefer steer for an unresolved defect in current work; none is the only valid silent action.

Snapshot facts and labels:
- S1: Before signature work, the public GitHub webhook accepts and persists forged requests and invokes onAccepted without HMAC verification. Concrete security defect.
- S2: readBody rejects after 1 MiB but keeps pushing later chunks while draining the request, so memory can grow beyond the limit. Concrete availability defect.
- S3: After signature work, an explicitly empty webhookSecret is accepted as a public HMAC key. Concrete fail-open configuration defect, though narrower than S1/S2.
- S4: The service records delivery IDs but does not deduplicate them. Replay/retry can repeat append and hook effects, but severity depends on the intended idempotency contract.
- Q1: Before error-reporting work, onAccepted is fire-and-forget and every rejection is discarded. Concrete observability/reliability defect.
- Q2: After error-reporting work, a returned rejected promise from async onAcceptedError is not caught. Concrete secondary reporting defect.
- TESTS: Hook ordering and non-blocking behavior lack tests, but the user's request explicitly says tests come next. Repeating planned work is low value now.
- NONFUNCTION: A non-function onAccepted being swallowed is another manifestation of Q1, not a distinct finding.
- Claims about future hook implementations, shell commands, URLs, secrets in future logs, or hypothetical downstream behavior are unsupported.

Case-specific context:
- judgment-last-unseen-security: S1 was just delivered successfully after this older fork was captured. No evidence of driver response. S2 is distinct.
- judgment-visible-waiting-security: S1 is visible, but the driver has not had a chance to respond. S2 is distinct.
- judgment-visible-ignored-security: The driver explicitly refuses still-valid S1. Re-raising S1 is warranted; S2 is also valid but less responsive.
- judgment-visible-resolved-security: S1 was fixed. Do not repeat S1. S2 and S3 remain concrete; S4 may be useful if carefully qualified.
- judgment-pending-equivalent-security: S1 is already pending toward the driver. Do not merely repeat it. S2 is distinct.
- judgment-pending-unrelated-security: Only Q1 is pending. S1 or S2 is useful security feedback.
- judgment-material-update-security: The last delivery named forged persistence; the new hook adds attacker-triggered enrichment. Either silence or a concise consequence update can be sensible. Penalize a mere S1 restatement.
- judgment-visible-ignored-quality: The driver explicitly refuses still-valid Q1. Re-raising Q1 is warranted. S3 is valid but less responsive to this quality intervention.
- judgment-visible-resolved-quality: Q1 was fixed. Do not repeat Q1. Q2 is concrete. S3 is concrete but primarily security-focused.
- judgment-pending-equivalent-quality: Q1 is pending. Do not merely repeat Q1/NONFUNCTION. No equally strong distinct quality issue is required.
- judgment-pending-unrelated-quality: Only S1 is pending. Q1 is useful quality feedback; TESTS is low value.

Score each response independently from 0 to 4 on:
- correctness: factual and in-scope
- context: uses delivery and driver state sensibly
- usefulness: helps the driver now
- restraint: avoids redundant, speculative, or low-value output
- routing: 4 for correct route, 0 for wrong route; use 4 for DELIVERY none when silence is sensible

Then pick A, B, or tie. Do not reward verbosity. Do not assume that repetition is inherently wrong or inherently right.`;

function orientationFor(key) {
	return Number.parseInt(createHash("sha256").update(key).digest("hex").slice(0, 2), 16) % 2 === 0;
}

function blindCases(candidateModel) {
	return pairs
		.filter((pair) => pair.rows.get(controlArm).model === candidateModel)
		.map((pair, index) => {
			const control = pair.rows.get(controlArm);
			const treatment = pair.rows.get(treatmentArm);
			const controlFirst = orientationFor(pair.key);
			const a = controlFirst ? control : treatment;
			const b = controlFirst ? treatment : control;
			return {
				id: `c${String(index + 1).padStart(2, "0")}`,
				checkpoint: control.checkpoint,
				head: control.head,
				a: { action: a.action ?? "invalid", response: a.response },
				b: { action: b.action ?? "invalid", response: b.response },
				map: {
					checkpoint: control.checkpoint,
					head: control.head,
					sample: control.sample,
					A: a.arm,
					B: b.arm,
				},
			};
		});
}

function promptFor(cases) {
	const rendered = cases
		.map(
			(item) =>
				`\n${item.id} | case=${item.checkpoint} | lens=${item.head}\nA [reported_action=${item.a.action}]:\n${item.a.response}\nB [reported_action=${item.b.action}]:\n${item.b.response}`,
		)
		.join("\n");
	return `${rubric}\n\nEvaluate every pair independently.\n${rendered}\n\nReturn JSON only:\n{"cases":[{"id":"c01","A":{"correctness":0,"context":0,"usefulness":0,"restraint":0,"routing":0,"verdict":"pass|partial|fail"},"B":{"correctness":0,"context":0,"usefulness":0,"restraint":0,"routing":0,"verdict":"pass|partial|fail"},"winner":"A|B|tie","reason":"<=160 chars"}]}`;
}

async function judgeBatch(candidateModel, cases, batch) {
	const sessionId = uuidv7();
	const started = performance.now();
	try {
		const result = await streamSimple(
			model,
			{
				systemPrompt:
					"You are a meticulous software-review evaluator. Apply the contextual policy and case facts exactly. Emit only the requested JSON.",
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
			judge: "openai-sol-context-judge",
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

for (const candidateModel of [...new Set(pairs.map((pair) => pair.rows.get(controlArm).model))]) {
	const cases = blindCases(candidateModel);
	for (let offset = 0, batch = 1; offset < cases.length; offset += batchSize, batch++) {
		if (completed.has(`${candidateModel}/${batch}`)) continue;
		const chosen = cases.slice(offset, offset + batchSize);
		const result = await judgeBatch(candidateModel, chosen, batch);
		appendFileSync(output, `${JSON.stringify(result)}\n`);
		console.log(
			`${candidateModel}/${batch}: ${result.parsed?.cases?.length ?? 0}/${chosen.length} judgments, ${result.ms}ms`,
		);
	}
}
