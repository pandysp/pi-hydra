#!/usr/bin/env node
/**
 * Paired, resumable control/treatment runner for the frozen delivery-context
 * corpus. Arm order is randomized inside each case/model/sample pair.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	buildAnthropicObservationPrompt,
	buildJudgeObservationEnvelope,
	buildJudgeObservationPrompt,
	buildObservationEnvelope,
	decisionFromCompletion,
	footerFormatCorrection,
	parseDecision,
	parseFooterDecision,
} from "../utils.ts";
import {
	completionFromHydraToolCalls,
	hydraToolDescription,
	hydraToolParameters,
	validateHydraToolParams,
} from "../protocol.ts";
import {
	buildUnifiedFooterToolFreeObservationEnvelope,
	buildUnifiedFooterToolFreeObservationPrompt,
} from "./tool-free-protocol.mjs";
import { GOLDEN_CASES, GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import {
	buildCandidate2ObservationEnvelope,
	buildCandidate2ObservationPrompt,
	buildCandidate3ObservationEnvelope,
	buildCandidate3ObservationPrompt,
	buildCandidate4ObservationEnvelope,
	buildCandidate4ObservationPrompt,
	buildCandidateObservationEnvelope,
	buildCandidateObservationPrompt,
	buildStructuredContextObservationEnvelope,
	buildStructuredContextObservationPrompt,
	buildStructuredCandidateObservationEnvelope,
	buildStructuredCandidateObservationPrompt,
	parseStructuredCandidateDecision,
	parseStructuredContextDecision,
	structuredCandidateFormatCorrection,
	structuredContextFormatCorrection,
} from "./delivery-context-candidate.mjs";
import { argOf } from "./lib.mjs";
import {
	buildScreenFooterObservationEnvelope,
	buildScreenFooterObservationPrompt,
	buildScreenJsonObservationEnvelope,
	buildScreenJsonObservationPrompt,
	buildShippedMainObservationEnvelope,
	buildShippedMainObservationPrompt,
	implementationArm,
	isDeliveryBucketCorrect,
	sameHeadDeliveryContext,
	visibleDriverTools,
} from "./delivery-context-evaluation.mjs";
import { resolveModel } from "./model-catalog.mjs";

const args = process.argv.slice(2);
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "2"), 10);
const concurrency = Number.parseInt(argOf(args, "--concurrency", "2"), 10);
const requestedModels = argOf(args, "--models", "").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "A,B,C").split(",").filter(Boolean);
const requestedCases = argOf(args, "--cases", "").split(",").filter(Boolean);
const requestedCategories = argOf(args, "--categories", "").split(",").filter(Boolean);
const corpusName = argOf(args, "--corpus", "golden");
const retryErrors = args.includes("--retry-errors");
const skipWarm = args.includes("--no-warm");

if (!outputPath) throw new Error("--output is required");
if (requestedModels.length === 0) throw new Error("--models is required");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

const modelSpecs = {
	"luna-medium": { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: "medium" },
	"luna-high": { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: "high" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: "low" },
	"terra-medium": { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: "medium" },
	"terra-high": { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: "high" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "low" },
	"sol-medium": { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "medium" },
	"sol-high": { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "high" },
	sonnet: { provider: "anthropic", id: "claude-sonnet-5", reasoning: "low" },
	"sonnet-medium": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "medium" },
	"sonnet-high": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "high" },
	opus: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
	"opus-medium": { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
	"opus-high": { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
	"fable-medium": { provider: "anthropic", id: "claude-fable-5", reasoning: "medium" },
	"fable-high": { provider: "anthropic", id: "claude-fable-5", reasoning: "high" },
};
// C must mirror DeliveryLedger.contextFor(): the observing head sees its own
// last successful delivery and its own live pending queue/steer deliveries.
// The ledger tracks sibling heads internally, but intentionally does not use
// them to coordinate otherwise-MECE reviews.
const knownArms = new Set([
	"A",
	"B",
	"C",
	"control",
	"main-json",
	"base",
	"treatment",
	"samehead",
	"unseenonly",
	"candidate",
	"candidate2",
	"candidate3",
	"candidate4",
	"structured",
	"structured2",
	"A0",
	"J",
	"F",
	"screen-a0",
	"screen-json",
	"screen-footer",
]);
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model: ${name}`);
}
for (const arm of requestedArms) {
	if (!knownArms.has(arm)) throw new Error(`unknown arm: ${arm}`);
}

const corpus =
	corpusName === "golden"
		? GOLDEN_CASES
		: corpusName === "development"
			? DEVELOPMENT_CASES
			: corpusName === "screen"
				? SCREEN_CASES
				: null;
if (!corpus) throw new Error(`unknown corpus: ${corpusName}`);
const cases = corpus.filter(
	(item) =>
		(requestedCases.length === 0 || requestedCases.includes(item.id)) &&
		(requestedCategories.length === 0 || requestedCategories.includes(item.category)),
);
if (requestedCases.some((id) => !corpus.some((item) => item.id === id))) {
	throw new Error(`unknown case in: ${requestedCases.join(",")}`);
}
if (cases.length === 0) throw new Error("no golden cases selected");

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

function assistantMessage(text, model) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function messagesFor(testCase, model) {
	return testCase.messages.map((message) =>
		message.role === "assistant"
			? assistantMessage(message.text, model)
			: { role: "user", content: [{ type: "text", text: message.text }], timestamp: Date.now() },
	);
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function inputText(item) {
	return (item?.content ?? [])
		.filter((block) => block?.type === "input_text")
		.map((block) => block.text)
		.join("");
}

function usageOf(messages) {
	return messages
		.filter((message) => message.role === "assistant")
		.reduce(
			(sum, message) => ({
				input: sum.input + (message.usage?.input ?? 0),
				output: sum.output + (message.usage?.output ?? 0),
				cacheRead: sum.cacheRead + (message.usage?.cacheRead ?? 0),
				cacheWrite: sum.cacheWrite + (message.usage?.cacheWrite ?? 0),
				cost: sum.cost + (message.usage?.cost?.total ?? 0),
			}),
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
}

function hitRatio(usage) {
	const readable = usage.input + usage.cacheRead + usage.cacheWrite;
	return readable > 0 ? (usage.cacheRead / readable) * 100 : 0;
}

function promptFor(arm, provider, testCase) {
	const head = testCase.head;
	const lens = GOLDEN_HEADS[head];
	if (!lens) throw new Error(`missing frozen head: ${head}`);
	const deliveryState =
		arm === "unseenonly"
			? {
					lastByThisHead:
						testCase.category === "newly-delivered-no-response" ? testCase.state.lastByThisHead : null,
					pending: testCase.state.pending.filter((item) => item.head === head),
				}
			: arm === "samehead"
				? sameHeadDeliveryContext(testCase.state, head)
			: testCase.state;
	if (arm === "main-json") {
		return { prompt: buildShippedMainObservationPrompt(head, lens) };
	}
	// The screen arms hold the placement residue constant: combined user
	// <system-reminder> on Anthropic, raw lens plus developer envelope on
	// OpenAI. main-json keeps its combined-on-both placement for history.
	if (arm === "screen-a0") {
		return provider === "anthropic"
			? { prompt: buildShippedMainObservationPrompt(head, lens) }
			: { prompt: lens, envelope: buildShippedMainObservationEnvelope(head) };
	}
	if (arm === "screen-json") {
		return provider === "anthropic"
			? { prompt: buildScreenJsonObservationPrompt(head, lens) }
			: { prompt: lens, envelope: buildScreenJsonObservationEnvelope(head) };
	}
	if (arm === "screen-footer") {
		return provider === "anthropic"
			? { prompt: buildScreenFooterObservationPrompt(head, lens) }
			: { prompt: lens, envelope: buildScreenFooterObservationEnvelope(head) };
	}
	if (arm === "control") {
		return provider === "anthropic"
			? { prompt: buildAnthropicObservationPrompt(head, lens, []) }
			: { prompt: lens, envelope: buildObservationEnvelope(head, []) };
	}
	if (arm === "base") {
		return provider === "anthropic"
			? { prompt: buildUnifiedFooterToolFreeObservationPrompt(head, lens, []) }
			: { prompt: lens, envelope: buildUnifiedFooterToolFreeObservationEnvelope(head, []) };
	}
	if (arm === "candidate") {
		return provider === "anthropic"
			? { prompt: buildCandidateObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildCandidateObservationEnvelope(head, testCase.state) };
	}
	if (arm === "candidate2") {
		return provider === "anthropic"
			? { prompt: buildCandidate2ObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildCandidate2ObservationEnvelope(head, testCase.state) };
	}
	if (arm === "candidate3") {
		return provider === "anthropic"
			? { prompt: buildCandidate3ObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildCandidate3ObservationEnvelope(head, testCase.state) };
	}
	if (arm === "candidate4") {
		return provider === "anthropic"
			? { prompt: buildCandidate4ObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildCandidate4ObservationEnvelope(head, testCase.state) };
	}
	if (arm === "structured") {
		return provider === "anthropic"
			? { prompt: buildStructuredContextObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildStructuredContextObservationEnvelope(head, testCase.state) };
	}
	if (arm === "structured2") {
		return provider === "anthropic"
			? { prompt: buildStructuredCandidateObservationPrompt(head, lens, testCase.state) }
			: { prompt: lens, envelope: buildStructuredCandidateObservationEnvelope(head, testCase.state) };
	}
	return provider === "anthropic"
		? { prompt: buildJudgeObservationPrompt(head, lens, deliveryState) }
		: { prompt: lens, envelope: buildJudgeObservationEnvelope(head, deliveryState) };
}

function payloadTransform(spec, arm, promptText, envelope, roles) {
	return (body) => {
		if (spec.provider === "anthropic") {
			const messages = structuredClone(body.messages);
			if (envelope !== undefined) {
				const index = messages.findIndex((message) => message.role === "user" && textOf(message) === promptText);
				if (index === -1) throw new Error("serialized Anthropic lens not found");
				messages.splice(index + 1, 0, { role: "system", content: [{ type: "text", text: envelope }] });
			}
			roles.value = messages.slice(-5).map((message) => message.role).join(",");
			return { ...body, messages, tools: visibleDriverTools(spec.provider, arm, body.tools) };
		}
		const input = structuredClone(body.input);
		const index = input.findIndex((item) => item?.role === "user" && inputText(item) === promptText);
		if (index === -1) throw new Error("serialized OpenAI lens not found");
		if (envelope !== undefined) {
			input.splice(index + 1, 0, {
				type: "message",
				role: "developer",
				content: [{ type: "input_text", text: envelope }],
			});
		}
		roles.value = input.slice(-5).map((item) => item?.role ?? item?.type ?? "?").join(",");
		return { ...body, input, tools: visibleDriverTools(spec.provider, arm, body.tools) };
	};
}

function controlHydraTool(state) {
	return {
		name: "hydra",
		label: "Hydra",
		description: hydraToolDescription("the frozen benchmark head directory"),
		parameters: hydraToolParameters,
		async execute(_id, rawParams) {
			const params = validateHydraToolParams(rawParams);
			if (params.action !== "complete_observation") {
				throw new Error("Judge-only benchmark heads cannot manage heads");
			}
			if (state.completion) throw new Error("complete_observation was already accepted");
			state.completion = decisionFromCompletion(params.delivery, params.message);
			return {
				content: [{ type: "text", text: "Observation completed." }],
				details: { action: params.action },
				terminate: true,
			};
		},
	};
}

function priorExactDeliveries(testCase) {
	const values = new Set();
	for (const message of testCase.messages) {
		if (message.role !== "user") continue;
		const match = message.text.match(/^\[([^\]]+)\]\s+([\s\S]+)$/);
		if (match) values.add(`${match[1]}|steer|${match[2].trim()}`);
	}
	if (testCase.state.lastByThisHead) {
		const item = testCase.state.lastByThisHead;
		values.add(`${testCase.head}|${item.delivery}|${item.message}`);
	}
	for (const item of testCase.state.pending) {
		values.add(`${item.head}|${item.delivery}|${item.message}`);
	}
	return values;
}

function applyControlRuntimeDedup(testCase, decision) {
	if (!decision || decision.action === "noop" || !decision.message) {
		return { delivery: decision?.action === "noop" ? "none" : null, suppressed: false };
	}
	const key = `${testCase.head}|${decision.action}|${decision.message}`;
	return priorExactDeliveries(testCase).has(key)
		? { delivery: "none", suppressed: true }
		: { delivery: decision.action, suppressed: false };
}

/**
 * A's lenient parse with A's failure policy: an unparseable reply is a warned
 * noop, never a recovery turn. The non-null decision is what keeps the recovery
 * branch below unreachable, so these arms spend exactly one provider call.
 */
function failOpenJsonDecision(text, error) {
	const legacy = parseDecision(text);
	return {
		decision: legacy ?? { action: "noop", reason: "unparseable response", message: "" },
		candidate: null,
		relation: null,
		error: legacy ? null : error,
		formatValid: legacy !== null,
	};
}

async function measuredObservation({ model, spec, testCase, arm, context, prompt, options, state }) {
	let providerCalls = 0;
	let recoveryAttempted = false;
	let initialCompletionError = null;
	let allMessages;
	let response;
	let decision = null;
	let initialResponseText = null;
	let initialStopReason = null;
	let initialContent = null;
	let relation = null;
	let contextCandidate = null;
	let completionFormatValid = null;

	if (arm === "control") {
		allMessages = await runAgentLoop(
			[prompt],
			context,
			{
				...options,
				convertToLlm: (messages) => messages,
				onPayload: (body) => {
					providerCalls++;
					return options.onPayload(body);
				},
				shouldStopAfterTurn: () => state.completion !== null || spec.provider === "anthropic",
			},
			() => {},
			undefined,
			streamSimple,
		);
		response = [...allMessages].reverse().find((message) => message.role === "assistant");
		decision = state.completion ?? parseDecision(textOf(response));
	} else {
		response = await streamSimple(
			model,
			{ ...context, messages: [...context.messages, prompt] },
			{
				...options,
				onPayload: (body) => {
					providerCalls++;
					return options.onPayload(body);
				},
			},
		).result();
		initialResponseText = textOf(response);
		initialStopReason = response.stopReason ?? null;
		initialContent = response.content;
		allMessages = [response];
		const parseResponse = (message) => {
			if (arm === "main-json") {
				return failOpenJsonDecision(textOf(message), "unparseable JSON; shipped main falls back to noop");
			}
			if (arm === "screen-a0" || arm === "screen-json") {
				return failOpenJsonDecision(textOf(message), "unparseable JSON; A's contract falls back to noop");
			}
			// F is the only screen arm with a recovery budget, and a tool call is
			// never a completion here: the advertised schema has no completion action.
			if (arm === "screen-footer") {
				return { ...parseFooterDecision(textOf(message)), candidate: null, relation: null };
			}
			if (arm === "structured") return parseStructuredContextDecision(textOf(message));
			if (arm === "structured2") return parseStructuredCandidateDecision(textOf(message));
			const typed = completionFromHydraToolCalls(message.content);
			return typed
				? { decision: decisionFromCompletion(typed.delivery, typed.message), candidate: null, relation: null, error: null }
				: { ...parseFooterDecision(textOf(message)), candidate: null, relation: null };
		};
		let parsed = parseResponse(response);
		completionFormatValid = parsed.formatValid ?? parsed.decision !== null;
		relation = parsed.relation;
		contextCandidate = parsed.candidate ?? null;
		initialCompletionError = parsed.error;
		if (!parsed.decision && !response.errorMessage && providerCalls < 2) {
			recoveryAttempted = true;
			const correction = {
				role: "user",
				content: [{
					type: "text",
					text:
						arm === "structured2"
							? structuredCandidateFormatCorrection(parsed.error ?? "invalid completion")
							: arm === "structured"
							? structuredContextFormatCorrection(parsed.error ?? "invalid completion")
							: footerFormatCorrection(parsed.error ?? "invalid completion"),
				}],
				timestamp: Date.now(),
			};
			const recovered = await streamSimple(
				model,
				{ ...context, messages: [...context.messages, prompt, response, correction] },
				{
					...options,
					onPayload: (body) => {
						providerCalls++;
						return options.onPayload(body);
					},
				},
			).result();
			response = recovered;
			allMessages = [...allMessages, recovered];
			parsed = parseResponse(recovered);
			completionFormatValid = parsed.formatValid ?? parsed.decision !== null;
			relation = parsed.relation;
			contextCandidate = parsed.candidate ?? null;
		}
		decision = parsed.decision;
	}

	return {
		allMessages,
		response,
		decision,
		providerCalls,
		recoveryAttempted,
		initialCompletionError,
		initialResponseText,
		initialStopReason,
		initialContent,
		relation,
		contextCandidate,
		completionFormatValid,
	};
}

async function runOne(modelName, testCase, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);
	const resolvedArm = implementationArm(arm);
	const handoff = promptFor(resolvedArm, spec.provider, testCase);
	const prompt = { role: "user", content: [{ type: "text", text: handoff.prompt }], timestamp: Date.now() };
	const state = { completion: null };
	const tools = [controlHydraTool(state)];
	const context = {
		systemPrompt: `You are pi, a coding agent. Frozen golden benchmark nonce: ${uuidv7()}.`,
		messages: messagesFor(testCase, model),
		tools,
	};
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const roles = { value: "" };
	const onPayload = payloadTransform(spec, resolvedArm, handoff.prompt, handoff.envelope, roles);
	const options = {
		model,
		apiKey: auth[spec.provider].access,
		reasoning: spec.reasoning,
		sessionId,
		transport: spec.provider === "openai-codex" ? "websocket" : undefined,
		onPayload,
	};

	try {
		let warmMs = null;
		if (!skipWarm) {
			const warmStarted = performance.now();
			await streamSimple(model, { ...context, messages: [...context.messages, prompt] }, options).result();
			warmMs = Math.round(performance.now() - warmStarted);
		}
		state.completion = null;
		const started = performance.now();
		const measured = await measuredObservation({ model, spec, testCase, arm: resolvedArm, context, prompt, options, state });
		const ms = Math.round(performance.now() - started);
		const responseText = textOf(measured.response);
		const usage = usageOf(measured.allMessages);
		const routed = resolvedArm === "control" || resolvedArm === "main-json"
			? applyControlRuntimeDedup(testCase, measured.decision)
			: {
					delivery: measured.decision?.action === "noop" ? "none" : (measured.decision?.action ?? null),
					suppressed: false,
				};
		return {
			model: modelName,
			modelId: model.id,
			provider: spec.provider,
			thinking: spec.reasoning,
			case: testCase.id,
			trajectory: testCase.trajectory,
			head: testCase.head,
			category: testCase.category,
			counterfactual: testCase.counterfactual,
			critical: testCase.critical,
			sample,
			arm,
			implementationArm: resolvedArm,
			expectedDelivery: testCase.expectedDelivery,
			expectedFinding: testCase.expectedFinding,
			promptHash: createHash("sha256").update(`${handoff.prompt}\n${handoff.envelope ?? ""}`).digest("hex"),
			roles: roles.value,
			warmMs,
			ms,
			providerCalls: measured.providerCalls,
			recoveryAttempted: measured.recoveryAttempted,
			initialCompletionError: measured.initialCompletionError,
			initialResponse: measured.initialResponseText,
			initialStop: measured.initialStopReason,
			initialContent: measured.initialContent,
			contextRelation: measured.relation,
			contextCandidate: measured.contextCandidate,
			completionValid: measured.decision !== null,
			formatValid: measured.completionFormatValid ?? measured.decision !== null,
			rawDelivery: measured.decision?.action === "noop" ? "none" : (measured.decision?.action ?? null),
			delivery: routed.delivery,
				deliveryCorrect: isDeliveryBucketCorrect(routed.delivery, testCase.expectedDelivery),
				deliveryExact: routed.delivery !== null && routed.delivery === testCase.expectedDelivery,
			runtimeSuppressed: routed.suppressed,
			message: measured.decision?.message ?? "",
			response: responseText,
			stop: measured.response?.stopReason ?? null,
			error: measured.response?.errorMessage ?? null,
			usage,
			hitRatio: hitRatio(usage),
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (!retryErrors || !row.error) completed.add(`${row.model}/${row.case}/${row.sample}/${row.arm}`);
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const testCase of cases) {
		for (let sample = 1; sample <= samples; sample++) tasks.push({ model, testCase, sample });
	}
}
for (let index = tasks.length - 1; index > 0; index--) {
	const other = Math.floor(Math.random() * (index + 1));
	[tasks[index], tasks[other]] = [tasks[other], tasks[index]];
}

console.error(`${tasks.length} pairs / ${tasks.length * requestedArms.length} calls; ${completed.size} complete`);
let cursor = 0;
async function worker() {
	while (cursor < tasks.length) {
		const task = tasks[cursor++];
		const arms = [...requestedArms].sort(() => Math.random() - 0.5);
		for (const arm of arms) {
			const key = `${task.model}/${task.testCase.id}/${task.sample}/${arm}`;
			if (completed.has(key)) continue;
			let row;
			try {
				row = await runOne(task.model, task.testCase, task.sample, arm);
			} catch (error) {
				row = {
					model: task.model,
					case: task.testCase.id,
					sample: task.sample,
					arm,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.log(`${key}: ${row.delivery ?? "ERROR"} ${row.deliveryCorrect ? "PASS" : "FAIL"} ${row.ms ?? "?"}ms`);
		}
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
