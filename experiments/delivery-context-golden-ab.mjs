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
import { decisionFromCompletion, parseDecision } from "../utils.ts";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../protocol.ts";
import { GOLDEN_CASES } from "./delivery-context-golden-cases.mjs";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import { argOf } from "./lib.mjs";
import {
	armContractHash,
	armSpec,
	armVisibleDriverTools,
	assertDistinctImplementations,
	goldenHandoff,
	headLens,
	implementationArm,
	isKnownArm,
} from "./arm-registry.mjs";
import { isDeliveryBucketCorrect } from "./delivery-context-evaluation.mjs";
import {
	assertCaseMembership,
	buildRunHeader,
	caseHash,
	caseHashes,
	corpusHash,
	describeDrift,
	gitProvenance,
	headerDrift,
	lensHash,
	PRICE_DRIFT_FIELD,
	readRunHeader,
	RUN_HEADER_KIND,
} from "./fingerprints.mjs";
import { priceTable, pricesHash } from "./costing.mjs";
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
	"sonnet-xhigh": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "xhigh" },
	opus: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
	"opus-medium": { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
	"opus-high": { provider: "anthropic", id: "claude-opus-5", reasoning: "high" },
	"opus-xhigh": { provider: "anthropic", id: "claude-opus-5", reasoning: "xhigh" },
	"fable-medium": { provider: "anthropic", id: "claude-fable-5", reasoning: "medium" },
	"fable-high": { provider: "anthropic", id: "claude-fable-5", reasoning: "high" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model: ${name}`);
}
// Arm identity comes from one table (`arm-registry.mjs`); an arm it does not
// know has no contract, no parser and no fail-open policy, so it is a hard stop
// rather than a fallthrough to whatever the last if-chain branch happened to be.
for (const arm of requestedArms) {
	if (!isKnownArm(arm)) throw new Error(`unknown arm: ${arm}`);
}
assertDistinctImplementations(requestedArms);

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
				reasoning: sum.reasoning + (message.usage?.reasoning ?? 0),
				cacheRead: sum.cacheRead + (message.usage?.cacheRead ?? 0),
				cacheWrite: sum.cacheWrite + (message.usage?.cacheWrite ?? 0),
				cost: sum.cost + (message.usage?.cost?.total ?? 0),
			}),
			{ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		);
}

function hitRatio(usage) {
	const readable = usage.input + usage.cacheRead + usage.cacheWrite;
	return readable > 0 ? (usage.cacheRead / readable) * 100 : 0;
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
			return { ...body, messages, tools: armVisibleDriverTools(arm, spec.provider, body.tools) };
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
		return { ...body, input, tools: armVisibleDriverTools(arm, spec.provider, body.tools) };
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
	const armDefinition = armSpec(arm);
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

	if (armDefinition.runsAgentLoop) {
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
		const parseResponse = armDefinition.parse;
		let parsed = parseResponse(response);
		completionFormatValid = parsed.formatValid ?? parsed.decision !== null;
		relation = parsed.relation;
		contextCandidate = parsed.candidate ?? null;
		initialCompletionError = parsed.error;
		if (!parsed.decision && !response.errorMessage && providerCalls < 2) {
			recoveryAttempted = true;
			const correction = {
				role: "user",
				content: [{ type: "text", text: armDefinition.correction(parsed.error ?? "invalid completion") }],
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

/**
 * Every field that says WHICH cell a row belongs to, resolved without a
 * provider call so the error path can carry the same identity as the success
 * path. An error row used to be `{model, case, sample, arm, error}` only: with
 * no `provider` it grouped under a phantom `unknown/` configuration, and with
 * no `expectedDelivery` it scored `expectedDelivery !== "none"` as true and
 * `deliveryBucketCorrect` as false, so a single harness throw could read as a
 * refuted arm. `--gates` now hard-stops on such rows, but only because they are
 * identifiable at all.
 */
function rowIdentity(modelName, testCase, sample, arm) {
	const spec = modelSpecs[modelName];
	const resolvedArm = implementationArm(arm);
	return {
		model: modelName,
		modelId: spec.id,
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
		toolSurface: armSpec(resolvedArm).toolSurface,
		// S5 fingerprints, on the error path as well as the success path: a row
		// with no case identity is a permanent hole in the membership check.
		// `promptHash` (contract + this case's lens/state) stays the frozen
		// 64-hex definition and is stamped at the call site.
		caseHash: caseHash(testCase),
		contractHash: armContractHash(arm, spec.provider),
		expectedDelivery: testCase.expectedDelivery,
		expectedFinding: testCase.expectedFinding,
	};
}

async function runOne(modelName, testCase, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);
	const resolvedArm = implementationArm(arm);
	const handoff = goldenHandoff(resolvedArm, spec.provider, testCase);
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
			// Warm the DRIVER context only. Production replays the driver's cached
			// prefix and pays the observation prompt/envelope as uncached input on
			// every observation (mergeObservationPayload moves no marker for a plain
			// [prompt] tail). Warming prompt-inclusive would price arm-specific
			// prompt length at cache-read rates — ~10x under production — and make
			// longer contracts look nearly free on Anthropic.
			await streamSimple(model, { ...context }, options).result();
			warmMs = Math.round(performance.now() - warmStarted);
		}
		state.completion = null;
		const started = performance.now();
		const measured = await measuredObservation({ model, spec, testCase, arm: resolvedArm, context, prompt, options, state });
		const ms = Math.round(performance.now() - started);
		const responseText = textOf(measured.response);
		const usage = usageOf(measured.allMessages);
		const routed = armSpec(resolvedArm).runtimeDedup
			? applyControlRuntimeDedup(testCase, measured.decision)
			: {
					delivery: measured.decision?.action === "noop" ? "none" : (measured.decision?.action ?? null),
					suppressed: false,
				};
		return {
			...rowIdentity(modelName, testCase, sample, arm),
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

// ---------------------------------------------------------------------------
// Run header and resume-drift refusal (S5).
// ---------------------------------------------------------------------------

/**
 * The first line of the file records WHAT THIS RUN IS: the code, the corpus and
 * every case in it, each arm's contract, the lenses, and the price table the
 * dollar figures will be computed against. On resume the header is re-derived
 * and compared, and a run that would append different work into the same file
 * ABORTS.
 *
 * This is the check that was missing when the bd97f3e repair reached 36 of 492
 * arm-C cells: the frozen matrix carries 456 rows of one implementation and 36
 * of another under one arm label, and nothing on disk noticed. `--force-mixed`
 * exists for the case where mixing is deliberate, and it demands `--note` so
 * the reason lands in the artifact rather than in someone's memory.
 */
const forceMixed = args.includes("--force-mixed");
const mixedNote = argOf(args, "--note", "");
if (forceMixed && !mixedNote) throw new Error("--force-mixed requires --note \"<why mixing is deliberate>\"");
// Scoped escape for the one drift field backed by mutable user state. A `pi`
// catalog refresh mid-sweep moves `pricesHash` without the operator touching
// anything; clearing that must not also waive codeCommit, corpusHash and the
// per-case membership pre-flight, which is what `--force-mixed` does.
const forcePrices = args.includes("--force-prices");

const providersInRun = [...new Set(requestedModels.map((name) => modelSpecs[name].provider))].sort();
const prices = priceTable(
	requestedModels.map((name) => modelSpecs[name]),
	resolveModel,
);
const runHeader = buildRunHeader({
	script: "delivery-context-golden-ab.mjs",
	argv: args,
	...gitProvenance(),
	corpusName,
	corpusHash: corpusHash(corpusName, corpus),
	caseCount: corpus.length,
	caseHashes: caseHashes(corpus),
	selectedCases: cases.map((item) => item.id),
	models: requestedModels,
	providers: providersInRun,
	samples,
	arms: requestedArms,
	armImplementations: Object.fromEntries(requestedArms.map((arm) => [arm, implementationArm(arm)])),
	armContractHashes: Object.fromEntries(
		providersInRun.flatMap((provider) => requestedArms.map((arm) => [`${provider}/${arm}`, armContractHash(arm, provider)])),
	),
	lensHashes: Object.fromEntries([...new Set(corpus.map((item) => item.head))].sort().map((head) => [head, lensHash(headLens(head))])),
	prices,
	pricesHash: pricesHash(prices),
	forceMixed,
	note: mixedNote || null,
});

const previousHeader = readRunHeader(outputPath);
if (previousHeader) {
	const allDrift = headerDrift(previousHeader, runHeader);
	// Price drift is waivable on its own; everything else needs --force-mixed.
	const priceDrift = allDrift.filter((entry) => entry.field === PRICE_DRIFT_FIELD);
	const drift = forcePrices ? allDrift.filter((entry) => entry.field !== PRICE_DRIFT_FIELD) : allDrift;
	if (forcePrices && priceDrift.length > 0) {
		console.error(`WARNING: ${outputPath} was produced under a different price table — ${describeDrift(priceDrift)}; continuing because --force-prices (cost columns pool two price tables)`);
	}
	if (drift.length > 0) {
		const message = `${outputPath} was produced under a different environment — ${describeDrift(drift)}`;
		if (!forceMixed) {
			const priceOnly = drift.every((entry) => entry.field === PRICE_DRIFT_FIELD);
			throw new Error(
				`${message}. Write to a fresh --output, ${priceOnly ? "pass --force-prices to accept a catalog refresh, " : ""}or pass --force-mixed --note "<why>" to pool deliberately.`,
			);
		}
		console.error(`WARNING: ${message}; pooling anyway because --force-mixed (${mixedNote})`);
	}
} else if (existsSync(outputPath)) {
	// Absent fingerprint is unverified, not invalid: every artifact frozen before
	// this scheme has no header, and refusing here would make them unresumable.
	console.error(`NOTE: ${outputPath} has no run header (pre-S5 artifact) — appending without a provenance check`);
} else {
	appendFileSync(outputPath, `${JSON.stringify(runHeader)}\n`);
}

// Membership is checked for every selected case BEFORE the first call, not only
// when a worker reaches the offending one. Measured while verifying this guard:
// checking per row alone let 11 rows be produced before the drifted case came up
// in the shuffled order — on a real run that is 11 observations of spend against
// a corpus the file's header does not describe.
function checkMembership(testCase) {
	const result = assertCaseMembership(previousHeader ?? runHeader, testCase, { force: forceMixed });
	if (result.reason && forceMixed) console.error(`WARNING: ${result.reason}; producing anyway because --force-mixed (${mixedNote})`);
}
for (const testCase of cases) checkMembership(testCase);

const completed = new Set();
if (existsSync(outputPath)) {
	// The file is append-only, so a --retry-errors pass leaves the superseded
	// error row in place and appends the retry beside it. Readers resolve that
	// last-wins; the count is reported here because this is where it is created.
	const seen = new Set();
	let duplicates = 0;
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (row.kind === RUN_HEADER_KIND) continue;
		const key = `${row.model}/${row.case}/${row.sample}/${row.arm}`;
		if (seen.has(key)) duplicates++;
		seen.add(key);
		if (!retryErrors || !row.error) completed.add(key);
	}
	if (duplicates > 0) {
		console.error(`NOTE: ${outputPath} already holds ${duplicates} superseded row(s); readers must dedup last-wins`);
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
			// Refuse to write a row for a case this file's corpus does not
			// contain at the content its header recorded — the drift a resumed
			// run against an edited corpus would otherwise pool silently.
			checkMembership(task.testCase);
			let row;
			try {
				row = await runOne(task.model, task.testCase, task.sample, arm);
			} catch (error) {
				row = {
					...rowIdentity(task.model, task.testCase, task.sample, arm),
					error: error instanceof Error ? error.message : String(error),
				};
			}
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.log(`${key}: ${row.delivery ?? "ERROR"} ${row.deliveryCorrect ? "PASS" : "FAIL"} ${row.ms ?? "?"}ms`);
		}
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
