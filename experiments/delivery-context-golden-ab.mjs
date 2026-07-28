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
import { isDeliveryBucketCorrect } from "./delivery-context-evaluation.mjs";
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
const armImplementations = { A: "main-json", B: "control", C: "treatment" };
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
]);
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model: ${name}`);
}
for (const arm of requestedArms) {
	if (!knownArms.has(arm)) throw new Error(`unknown arm: ${arm}`);
}

const corpus = corpusName === "golden" ? GOLDEN_CASES : corpusName === "development" ? DEVELOPMENT_CASES : null;
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

const SHIPPED_MAIN_DECISION_SHAPE =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';

/** Exact judge-only observation prompt shipped on origin/main at b51c157. */
function buildShippedMainObservationPrompt(head, instruction) {
	return `<system-reminder>Side watcher. Reply with one JSON object, nothing else:
${SHIPPED_MAIN_DECISION_SHAPE}

LENS: ${instruction}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].</system-reminder>`;
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
			? { ...testCase.state, pending: testCase.state.pending.filter((item) => item.head === head) }
			: testCase.state;
	if (arm === "main-json") {
		return { prompt: buildShippedMainObservationPrompt(head, lens) };
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

const DRIVER_TOOL_STUBS = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	{ name: "edit", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
	{ name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

function visibleDriverTools(provider, serializedObservationTools) {
	const stubs = DRIVER_TOOL_STUBS.map((tool) =>
		provider === "anthropic"
			? {
					name: tool.name,
					description: tool.description,
					input_schema: tool.parameters,
				}
			: {
					type: "function",
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					strict: false,
				},
	);
	return [...stubs, ...(serializedObservationTools ?? [])];
}

function payloadTransform(spec, promptText, envelope, roles) {
	return (body) => {
		if (spec.provider === "anthropic") {
			const messages = structuredClone(body.messages);
			if (envelope !== undefined) {
				const index = messages.findIndex((message) => message.role === "user" && textOf(message) === promptText);
				if (index === -1) throw new Error("serialized Anthropic lens not found");
				messages.splice(index + 1, 0, { role: "system", content: [{ type: "text", text: envelope }] });
			}
			roles.value = messages.slice(-5).map((message) => message.role).join(",");
			return { ...body, messages, tools: visibleDriverTools(spec.provider, body.tools) };
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
		return { ...body, input, tools: visibleDriverTools(spec.provider, body.tools) };
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
				const legacy = parseDecision(textOf(message));
				return {
					decision: legacy ?? { action: "noop", reason: "unparseable response", message: "" },
					candidate: null,
					relation: null,
					error: legacy ? null : "unparseable JSON; shipped main falls back to noop",
					formatValid: legacy !== null,
				};
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
	const implementationArm = armImplementations[arm] ?? arm;
	const handoff = promptFor(implementationArm, spec.provider, testCase);
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
	const onPayload = payloadTransform(spec, handoff.prompt, handoff.envelope, roles);
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
			const measured = await measuredObservation({ model, spec, testCase, arm: implementationArm, context, prompt, options, state });
		const ms = Math.round(performance.now() - started);
		const responseText = textOf(measured.response);
		const usage = usageOf(measured.allMessages);
			const routed = implementationArm === "control" || implementationArm === "main-json"
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
				implementationArm,
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
