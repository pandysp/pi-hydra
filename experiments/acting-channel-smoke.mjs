#!/usr/bin/env node
/**
 * Acting-head completion-channel smoke: typed+wide vs JSON+management-only vs
 * footer+management-only, with the unified envelope held byte-identical across
 * the three (`acting-channel-arms.mjs` owns the arms; `--check` invariants live
 * in `acting-arm-invariants.check.mjs`).
 *
 * Every arm runs the real agent loop with real work tools in an isolated
 * workspace, so correctness is deterministic — each case asserts file content,
 * the exact changed-file set, the active head set, and the delivery. No judge,
 * no judge spend.
 *
 * What each case can discriminate, so the columns are not over-read:
 *   docs-write-none, tuner-edit-print   file work AND an exact delivery. Only
 *       these two make `modelDelivery` differ from the runtime-resolved
 *       `action`, so they alone make `correctModelDelivery` informative.
 *   foreman-add-security, -clean-recrew, -two-uncovered-risks   crew
 *       composition. Delivery is scored `noop|print` because the envelope
 *       tells the head its change already prints its own receipt; demanding a
 *       second print would score the head for disobeying the contract under
 *       test. `correct` and `correctModelDelivery` are identical here.
 *   foreman-self-remove   terminality (S3), the same way.
 *
 * Pre-committed decision rules, measured per config against T as incumbent:
 *   S1  F correct < T − 1 case, or F excursions > T, in either config
 *       ⇒ acting does not unify on the footer.
 *   S2  F or J providerCalls > T + 1 per observation in either config
 *       ⇒ the management-only schema costs more calls than it saves.
 *       Compute it twice: raw, and netted of `afterChangeRetries` (T enforces
 *       after-change by throwing a tool error, J and F resolve it post-hoc).
 *   S3  self-removal ≠ 1.00 providerCalls in any arm/config
 *       ⇒ index.ts:1741 is not channel-independent.
 *   S4  J completionValid < 100% with shape errors
 *       ⇒ the historical naming defect reproduces on the two-field shape.
 *   S5  the invariant check (zero spend) — run it first.
 *
 * Usage:
 *   node experiments/acting-channel-smoke.mjs --output rows.jsonl \
 *     --models terra-medium,sonnet-medium --arms T,J,F --samples 2
 *   node experiments/acting-channel-smoke.mjs --output rows.jsonl \
 *     --models terra-medium,sonnet-medium --cases foreman-self-remove --samples 4
 *
 * The second invocation raises n on the self-removal case alone; the resume key
 * skips the rows the first already wrote.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { applyAfterChangeDelivery } from "../utils.ts";
import { argOf } from "./lib.mjs";
import { resolveModel } from "./model-catalog.mjs";
import {
	ACTING_ARMS,
	actingArm,
	actingPayloadTransform,
	actingToolsFor,
	afterChangeRetriesOf,
	buildActingHandoff,
	createToolEventCollector,
	excursionsOf,
	handoffHash,
	isTerminalHydraCall,
	newActingState,
	selectActingCases,
} from "./acting-channel-arms.mjs";

const args = process.argv.slice(2);
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "2"), 10);
const concurrency = Number.parseInt(argOf(args, "--concurrency", "2"), 10);
const requestedModels = argOf(args, "--models", "").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "T,J,F").split(",").filter(Boolean);
const requestedCases = argOf(args, "--cases", "").split(",").filter(Boolean);
const retryErrors = args.includes("--retry-errors");
const skipWarm = args.includes("--no-warm");

if (!outputPath) throw new Error("--output is required");
if (requestedModels.length === 0) throw new Error("--models is required");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
for (const arm of requestedArms) actingArm(arm);

const modelSpecs = {
	"terra-medium": { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: "medium" },
	"terra-low": { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: "low" },
	"luna-medium": { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: "medium" },
	"sol-medium": { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: "medium" },
	"sonnet-medium": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "medium" },
	"sonnet-low": { provider: "anthropic", id: "claude-sonnet-5", reasoning: "low" },
	"opus-medium": { provider: "anthropic", id: "claude-opus-5", reasoning: "medium" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

const selectedCases = selectActingCases(requestedCases);
const MAX_ASSISTANT_TURNS = 10;

function snapshot(root) {
	const result = {};
	function visit(directory) {
		for (const name of readdirSync(directory)) {
			const absolute = join(directory, name);
			if (statSync(absolute).isDirectory()) visit(absolute);
			else result[relative(root, absolute)] = readFileSync(absolute, "utf8");
		}
	}
	visit(root);
	return result;
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
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function trajectoryMessages(trajectory, model) {
	return trajectory.map(([role, text]) =>
		role === "assistant"
			? assistantMessage(text, model)
			: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	);
}

function textOf(message) {
	return (message?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function hasToolCalls(message) {
	return (message?.content ?? []).some((block) => block.type === "toolCall");
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

async function runOne(modelName, testCase, sample, armName) {
	const spec = modelSpecs[modelName];
	const arm = actingArm(armName);
	const model = resolveModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);

	const root = mkdtempSync(join(tmpdir(), `hydra-acting-${modelName}-${testCase.id}-${sample}-${armName}-`));
	testCase.setup(root);
	const filesBefore = snapshot(root);
	const state = newActingState(testCase);

	const handoff = buildActingHandoff(armName, spec.provider, testCase);
	const prompt = { role: "user", content: [{ type: "text", text: handoff.prompt }], timestamp: Date.now() };
	const context = {
		systemPrompt: `You are pi, a coding agent. The working directory is ${root}. Benchmark nonce: ${uuidv7()}.`,
		messages: trajectoryMessages(testCase.trajectory, model),
		tools: actingToolsFor(root, testCase, state, armName),
	};
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const roles = { value: "" };
	const options = {
		model,
		apiKey: auth[spec.provider].access,
		maxTokens: 1800,
		reasoning: spec.reasoning,
		sessionId,
		transport: spec.provider === "openai-codex" ? "websocket" : undefined,
		onPayload: actingPayloadTransform(spec.provider, handoff.prompt, handoff.envelope, roles),
	};

	try {
		let warmMs = null;
		if (!skipWarm) {
			const warmStarted = performance.now();
			// Warm the DRIVER context only (`ba636ad`). Production replays the
			// driver's cached prefix and pays the observation prompt/envelope as
			// uncached input on every observation; warming prompt-inclusive would
			// price arm-specific prompt length at cache-read rates, ~10x under
			// production, and make longer contracts look nearly free on Anthropic.
			await streamSimple(model, { ...context }, options).result();
			warmMs = Math.round(performance.now() - warmStarted);
		}
		Object.assign(state, newActingState(testCase));

		let providerCalls = 0;
		const events = [];
		const loopOptions = {
			...options,
			convertToLlm: (messages) => messages,
			onPayload: (body) => {
				providerCalls++;
				return options.onPayload(body);
			},
			beforeToolCall: async ({ assistantMessage: message, toolCall, args: toolArgs }) => {
				if (toolCall.name !== "hydra" || !isTerminalHydraCall(armName, toolArgs, testCase.head)) {
					return undefined;
				}
				const calls = message.content.filter((block) => block.type === "toolCall");
				return calls.length === 1
					? undefined
					: { block: true, reason: "Terminal hydra actions must be the only tool call in their turn" };
			},
			// Excursion events are captured from the loop's emit stream (see
			// createToolEventCollector); this hook only tracks real state changes,
			// which prepare-time failures genuinely are not.
			afterToolCall: async (event) => {
				if (!event.isError && (event.toolCall.name === "write" || event.toolCall.name === "edit")) {
					state.fileStateChanged = true;
				}
				return undefined;
			},
			shouldStopAfterTurn: ({ newMessages }) =>
				state.completion !== null ||
				state.selfRemoved ||
				newMessages.filter((message) => message.role === "assistant").length >= MAX_ASSISTANT_TURNS,
		};

		const measuredStarted = performance.now();
		let allMessages = await runAgentLoop([prompt], context, loopOptions, createToolEventCollector(events), undefined, streamSimple);
		let response = [...allMessages].reverse().find((message) => message.role === "assistant");

		// The completion is read only from a turn that carries no tool calls: a
		// turn holding both a completion and a tool call is invalid under every
		// arm (the typed tool enforces it structurally, `index.ts:1176-1191`).
		const readCompletion = () => {
			if (arm.channel === "tool" && state.completion) return { decision: state.completion, error: null };
			// index.ts:901-903: a successful self-removal completes the observation
			// on every channel — the head that would answer no longer exists.
			if (state.selfRemoved) {
				return { decision: { action: "noop", reason: "completed by self-removal", message: "" }, error: null };
			}
			if (arm.channel === "tool") return { decision: null, error: "no complete_observation call" };
			if (hasToolCalls(response)) return { decision: null, error: "completion turn carried tool calls" };
			return arm.parse(textOf(response));
		};

		// The observation's work product is whatever it had produced when its own
		// loop ended. A format-correction turn may still call tools — the loop
		// executes them before `shouldStopAfterTurn` is consulted
		// (`agent-loop.js:128,151`) — so work is scored on this snapshot and any
		// mutation during recovery is reported rather than silently absorbed.
		const outcomeOf = () => ({
			filesAfter: snapshot(root),
			active: [...state.active],
			receipts: [...state.receipts],
			selfRemoved: state.selfRemoved,
			fileStateChanged: state.fileStateChanged,
		});
		const outcome = outcomeOf();

		let parsed = readCompletion();
		const completionValid = parsed.decision !== null;
		const completionError = parsed.error;
		let recoveryAttempted = false;
		let recoveryMutatedState = false;
		if (arm.correction && !parsed.decision && !response?.errorMessage) {
			recoveryAttempted = true;
			const correction = {
				role: "user",
				content: [{ type: "text", text: arm.correction(parsed.error ?? "invalid completion") }],
				timestamp: Date.now(),
			};
			const recoveredContext = { ...context, messages: [...context.messages, ...allMessages] };
			// Budget one assistant turn, counted in providerCalls. `newMessages`
			// accumulates within a single runAgentLoop call and starts as the
			// prompts it was given (`agent-loop.js:44,107`), so this stops after
			// exactly one assistant message. The correction asks only for a
			// re-serialization of a decision the head already made; a recovery turn
			// that instead calls a tool is a failed recovery, not a reason to pay on.
			const recoveryOptions = {
				...loopOptions,
				shouldStopAfterTurn: ({ newMessages }) => newMessages.some((message) => message.role === "assistant"),
			};
			// runAgentLoop returns its prompts followed by what it generated, so
			// `recovered` already carries the correction; re-adding it would
			// duplicate a message in the row.
			const recovered = await runAgentLoop([correction], recoveredContext, recoveryOptions, () => {}, undefined, streamSimple);
			allMessages = [...allMessages, ...recovered];
			response = [...recovered].reverse().find((message) => message.role === "assistant") ?? response;
			parsed = readCompletion();
			recoveryMutatedState = JSON.stringify(outcomeOf()) !== JSON.stringify(outcome);
		}

		const ms = Math.round(performance.now() - measuredStarted);
		const filesAfter = outcome.filesAfter;
		const changedFiles = [...new Set([...Object.keys(filesBefore), ...Object.keys(filesAfter)])]
			.filter((path) => filesBefore[path] !== filesAfter[path])
			.sort();
		const stateChanged = changedFiles.length > 0 || outcome.active.join(",") !== testCase.active.join(",");

		// What the model itself delivered, before the runtime resolved it. The
		// typed arm's after-change contract is enforced by a thrown tool error,
		// so its accepted completion is already compliant; J and F resolve
		// post-hoc on the same `fileStateChanged` gate production uses
		// (`index.ts:911-913`). Both actions are recorded so neither the frozen
		// comparison nor the arm discrimination has to be reconstructed later.
		const modelDelivery = parsed.decision?.action ?? null;
		const resolved =
			arm.channel === "tool" || !parsed.decision
				? parsed.decision
				: applyAfterChangeDelivery(parsed.decision, testCase.afterChange, outcome.fileStateChanged);

		const baseRun = {
			filesAfter,
			changedFiles,
			activeAfter: outcome.active,
			receipts: outcome.receipts,
			selfRemoved: outcome.selfRemoved,
		};
		const usage = usageOf(allMessages);
		return {
			model: modelName,
			modelId: model.id,
			provider: spec.provider,
			thinking: spec.reasoning,
			case: testCase.id,
			head: testCase.head,
			sample,
			arm: armName,
			armLabel: arm.label,
			schema: arm.schema,
			channel: arm.channel,
			promptHash: handoffHash(handoff),
			roles: roles.value,
			warmMs,
			ms,
			providerCalls,
			extraTurns: Math.max(0, providerCalls - 1),
			selfRemovalCalls: outcome.selfRemoved ? providerCalls : null,
			excursions: excursionsOf(events, testCase),
			afterChangeRetries: afterChangeRetriesOf(events),
			recoveryAttempted,
			recoveryMutatedState,
			completionValid,
			completionError,
			finalValid: parsed.decision !== null,
			modelDelivery,
			action: resolved?.action ?? null,
			correct: testCase.evaluate({ ...baseRun, action: resolved?.action ?? null }),
			correctModelDelivery: testCase.evaluate({ ...baseRun, action: modelDelivery }),
			selfRemoved: outcome.selfRemoved,
			stateChanged,
			fileStateChanged: outcome.fileStateChanged,
			receipts: outcome.receipts,
			toolCalls: events,
			changedFiles,
			filesAfter,
			activeBefore: testCase.active,
			activeAfter: outcome.active,
			stop: response?.stopReason ?? null,
			error: response?.errorMessage ?? null,
			usage,
			inputUncached: usage.input,
			outputTokens: usage.output,
			cost: usage.cost,
			hitRatio: hitRatio(usage),
			response: arm.channel === "tool" ? JSON.stringify(state.completion) : textOf(response),
			workdir: root,
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
	for (const testCase of selectedCases) {
		for (let sample = 1; sample <= samples; sample++) tasks.push({ model, testCase, sample });
	}
}
for (let index = tasks.length - 1; index > 0; index--) {
	const other = Math.floor(Math.random() * (index + 1));
	[tasks[index], tasks[other]] = [tasks[other], tasks[index]];
}

console.error(
	`acting channel smoke: ${tasks.length} cases / ${tasks.length * requestedArms.length} measured calls; arms ${requestedArms.join(",")}; concurrency ${concurrency}; ${completed.size} already complete`,
);
console.error(`arms available: ${Object.keys(ACTING_ARMS).join(",")}`);

let cursor = 0;
async function worker() {
	while (cursor < tasks.length) {
		const task = tasks[cursor++];
		const armOrder = [...requestedArms].sort(() => Math.random() - 0.5);
		for (const armName of armOrder) {
			const key = `${task.model}/${task.testCase.id}/${task.sample}/${armName}`;
			if (completed.has(key)) continue;
			let row;
			try {
				row = await runOne(task.model, task.testCase, task.sample, armName);
			} catch (error) {
				row = {
					model: task.model,
					case: task.testCase.id,
					sample: task.sample,
					arm: armName,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
			console.log(
				row.error
					? `${key}: ERROR ${row.error}`
					: `${key}: ${row.correct ? "PASS" : "FAIL"} ${row.action ?? "INVALID"} ${row.providerCalls} calls ` +
							`${row.excursions} exc ${row.ms}ms CH${row.hitRatio.toFixed(1)}%`,
			);
		}
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
