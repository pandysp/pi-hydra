#!/usr/bin/env node
/**
 * Paired A/B for the legacy JSON completion protocol and the enforceable
 * hydra completion action on immutable real-session review checkpoints.
 *
 * Each measured request is preceded by an identical, unrecorded warm request
 * in its own Codex/Anthropic session. That makes cache metrics comparable
 * without letting one randomized arm warm the other. Output is resumable
 * JSONL and arm order is randomized inside every pair.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	buildAnthropicObservationPrompt,
	buildObservationEnvelope,
	buildObservationPrompt,
	decisionFromCompletion,
	parseDecision,
} from "../utils.ts";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../protocol.ts";
import { argOf } from "./lib.mjs";
import {
	buildCacheAwareToolFreeObservationEnvelope,
	buildActionToolFreeObservationEnvelope,
	buildDeliveryActionToolFreeObservationEnvelope,
	buildCommitPointToolFreeObservationEnvelope,
	buildDecisionSequenceToolFreeObservationEnvelope,
	buildReviewRoutingToolFreeObservationEnvelope,
	buildCacheSafeReviewRoutingToolFreeObservationEnvelope,
	buildTagAwareReviewRoutingToolFreeObservationEnvelope,
	buildMessageFirstReviewRoutingToolFreeObservationEnvelope,
	buildConclusiveNoneReviewRoutingToolFreeObservationEnvelope,
	buildAssessedReviewRoutingToolFreeObservationEnvelope,
	buildFindingOnlyToolFreeObservationEnvelope,
	buildFindingOnlyToolFreeObservationPrompt,
	buildPriorFeedbackFindingOnlyObservationEnvelope,
	buildPriorFeedbackFindingOnlyObservationPrompt,
	buildFixedSteerMessageFooterToolFreeObservationPrompt,
	buildMessageFooterToolFreeObservationEnvelope,
	buildTagAwareMessageFooterToolFreeObservationEnvelope,
	buildPriorFeedbackMessageFooterToolFreeObservationEnvelope,
	buildStrongRoutingPriorFeedbackMessageFooterToolFreeObservationEnvelope,
	buildUnifiedFooterToolFreeObservationEnvelope,
	buildMessageFooterToolFreeObservationPrompt,
	buildUnifiedFooterToolFreeObservationPrompt,
	buildDeduplicatedToolEnvelope,
	buildToolFreeObservationEnvelope,
	buildToolFreeObservationPrompt,
	managementOnlyHydraDescription,
	capabilityScopedManagementOnlyHydraDescription,
	managementOnlyHydraParameters,
	parseToolFreeDecision,
	parseActionDecision,
	parseDeliveryActionDecision,
	parseAssessedDecision,
	parseFindingOnlyProbe,
	parseMessageFooterDecision,
	parseUnifiedFooterDecision,
	validateManagementOnlyParams,
} from "./tool-free-protocol.mjs";

const args = process.argv.slice(2);
const sessionPath = argOf(args, "--session", "");
const headsDir = argOf(args, "--heads-dir", "");
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "1"), 10);
const sampleStart = Number.parseInt(argOf(args, "--sample-start", "1"), 10);
const reasoning = argOf(args, "--thinking", "low");
const concurrency = Number.parseInt(argOf(args, "--concurrency", "3"), 10);
const retryErrors = args.includes("--retry-errors");
const anthropicSplit = args.includes("--anthropic-split");
const trace = args.includes("--trace");
const flatSchema = args.includes("--flat-schema");
const legacyCompletion = args.includes("--legacy-completion");
const requestedModels = argOf(args, "--models", "luna,terra,sol").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "json-control,tool-treatment").split(",").filter(Boolean);
const requestedCheckpoints = argOf(args, "--checkpoints", "").split(",").filter(Boolean);
const requestedHeads = argOf(args, "--heads", "").split(",").filter(Boolean);
const requestedCases = argOf(args, "--cases", "").split(",").filter(Boolean);

if (!sessionPath || !headsDir || !outputPath) {
	console.error("--session, --heads-dir, and --output are required");
	process.exit(1);
}
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(sampleStart) || sampleStart < 1 || sampleStart > samples) {
	throw new Error("--sample-start must be between 1 and --samples");
}
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");

const modelSpecs = {
	sonnet: { provider: "anthropic", id: "claude-sonnet-5" },
	opus: { provider: "anthropic", id: "claude-opus-4-8" },
	fable: { provider: "anthropic", id: "claude-fable-5" },
	luna: { provider: "openai-codex", id: "gpt-5.6-luna" },
	terra: { provider: "openai-codex", id: "gpt-5.6-terra" },
	sol: { provider: "openai-codex", id: "gpt-5.6-sol" },
};
for (const name of requestedModels) {
	if (!(name in modelSpecs)) throw new Error(`unknown model ${name}`);
}

const checkpoints = [
	{ id: "defects-visible", through: "6192600d", expected: { security: "steer", quality: "steer" } },
	{ id: "security-reported", through: "6b131390", expected: { security: "noop", quality: "steer" } },
	{ id: "both-reported", through: "af62d194", expected: { security: "noop", quality: "noop" } },
];
const headNames = ["security", "quality"];
const arms = [
	"json-control",
	"tool-treatment",
	"provider-current",
	"tool-dedup",
	"json-minimal",
	"json-full-schema",
	"json-full-schema-plain",
	"json-cache-aware",
	"json-action-full-schema",
	"json-action-minimal",
	"json-delivery-action",
	"json-commit-point",
	"json-decision-sequence",
	"json-review-routing",
	"json-review-routing-cache-safe",
	"json-review-routing-tag-aware",
	"json-review-routing-message-first",
	"json-review-routing-conclusive-none",
	"json-review-routing-assessed",
	"text-finding-only-probe",
	"text-finding-only-prior-feedback-bounded",
	"text-message-footer-fixed-steer-probe",
	"text-message-footer",
	"text-message-footer-tag-aware",
	"text-message-footer-prior-feedback",
	"text-message-footer-prior-feedback-strong-route",
	"text-message-footer-unified",
	"text-message-footer-unified-capability-schema",
	"text-message-footer-unified-bounded",
	"text-message-footer-unified-recovery-bounded",
];
if (requestedArms.some((arm) => !arms.includes(arm))) throw new Error(`unknown arm: ${requestedArms.join(",")}`);
if (requestedCheckpoints.some((id) => !checkpoints.some((checkpoint) => checkpoint.id === id))) {
	throw new Error(`unknown checkpoint: ${requestedCheckpoints.join(",")}`);
}
if (requestedHeads.some((head) => !headNames.includes(head))) throw new Error(`unknown head: ${requestedHeads.join(",")}`);
if (
	requestedCases.some((value) => {
		const [checkpoint, head, extra] = value.split("/");
		return extra !== undefined || !checkpoints.some((item) => item.id === checkpoint) || !headNames.includes(head);
	})
) {
	throw new Error(`unknown --cases value: ${requestedCases.join(",")}`);
}

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

function messagesThrough(throughId) {
	const messages = [];
	let found = false;
	for (const line of readFileSync(sessionPath, "utf8").trim().split("\n")) {
		const entry = JSON.parse(line);
		if (entry.type === "message") messages.push(entry.message);
		if (entry.id === throughId) {
			found = true;
			break;
		}
	}
	if (!found) throw new Error(`entry ${throughId} not found in ${sessionPath}`);
	return messages;
}

function readHead(name) {
	const raw = readFileSync(join(headsDir, `${name}.md`), "utf8");
	const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]+)$/);
	if (!match) throw new Error(`cannot parse ${name}.md`);
	return match[1].trim();
}

function priorFeedbackFor(messages, head) {
	const feedback = [];
	const tag = `[${head}]`;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const value = textOf(message).trim();
		if (/^\[[^\]]+\](?:\s|$)/.test(value)) {
			if (value.startsWith(tag)) feedback.unshift(value.slice(tag.length).trim());
			continue;
		}
		break;
	}
	return feedback;
}

const snapshots = Object.fromEntries(checkpoints.map((checkpoint) => [checkpoint.id, messagesThrough(checkpoint.through)]));
const heads = Object.fromEntries(headNames.map((name) => [name, readHead(name)]));

const legacyShape =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';
function legacyCombinedPrompt(head, lens) {
	return `<system-reminder>Side watcher. Reply with one JSON object, nothing else:
${legacyShape}

LENS: ${lens}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].</system-reminder>`;
}

function legacySplitEnvelope(head) {
	return `Side watcher. The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them. Review the visible trajectory and reply with one JSON object, nothing else:
${legacyShape}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to deliver a lens finding between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].`;
}

const legacyHydraParameters = Type.Object(
	{
		action: StringEnum(["add", "remove"]),
		head: Type.String(),
	},
	{ additionalProperties: false },
);

const flatHydraParameters = Type.Object(
	{
		action: StringEnum(["manage_heads", "complete_observation"]),
		operation: Type.Optional(StringEnum(["add", "remove"])),
		head: Type.Optional(Type.String()),
		delivery: Type.Optional(StringEnum(["none", "print", "queue", "steer", "interrupt"])),
		message: Type.String({ maxLength: 1000 }),
	},
	{ additionalProperties: false },
);

function legacyHydraDescription(userHeadDir) {
	return [
		"Point your hydra heads: `add` puts a head on the active set,",
		"`remove` takes it off (both idempotent; the set is session state). Each",
		"active head independently reviews your full context as you work. Heads",
		`are markdown files in ${userHeadDir} (user) and .pi/hydra (project):`,
		"frontmatter `name:` and `description:` are required; `tools:` is omitted",
		"for all tools, `[]` for a judge-only head, or a comma-separated subset;",
		"`autostart: true` joins fresh sessions; heads with write/edit/hydra may",
		"set `after-change:` to `noop` or `print`; the body is the head's",
		"instruction (one focus, clear conditions for acting, work, completion,",
		"and delivery). To create or tune a head, write the file, then add it:",
		"files are re-discovered on every call. Swap heads when work changes phase.",
	].join(" ");
}

function legacyHydraTool() {
	return {
		name: "hydra",
		label: "Hydra",
		description: legacyHydraDescription("the benchmark head directory"),
		parameters: legacyHydraParameters,
		async execute() {
			throw new Error("Judge-only benchmark heads cannot manage heads");
		},
	};
}

function treatmentHydraTool(state) {
	return {
		name: "hydra",
		label: "Hydra",
		description: hydraToolDescription("the benchmark head directory"),
		parameters: flatSchema ? flatHydraParameters : hydraToolParameters,
		async execute(_id, rawParams) {
			const params = validateHydraToolParams(rawParams);
			if (params.action !== "complete_observation") {
				throw new Error("Judge-only benchmark heads cannot manage heads");
			}
			if (state.completion) throw new Error("complete_observation was already accepted");
			state.completion = decisionFromCompletion(params.delivery, params.message);
			return {
				content: [{ type: "text", text: "Observation completed." }],
				details: { action: params.action, changed: false },
				terminate: true,
			};
		},
	};
}

function managementOnlyHydraTool() {
	return {
		name: "hydra",
		label: "Hydra",
		description: managementOnlyHydraDescription("the benchmark head directory"),
		parameters: managementOnlyHydraParameters,
		async execute(_id, rawParams) {
			validateManagementOnlyParams(rawParams);
			throw new Error("Judge-only benchmark heads cannot manage heads");
		},
	};
}

function capabilityScopedManagementOnlyHydraTool() {
	return {
		...managementOnlyHydraTool(),
		description: capabilityScopedManagementOnlyHydraDescription("the benchmark head directory"),
	};
}

function referenceOnlyHydraTool() {
	return {
		name: "hydra",
		label: "Hydra",
		description: hydraToolDescription("the benchmark head directory"),
		parameters: flatSchema ? flatHydraParameters : hydraToolParameters,
		async execute() {
			throw new Error(
				"This tool schema belongs to the cached driver prefix and is unavailable to this tool-free observation. Return the final JSON object.",
			);
		},
	};
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}

function completionText(state) {
	if (!state.completion) return "";
	return JSON.stringify({
		action: "complete_observation",
		delivery: state.completion.action === "noop" ? "none" : state.completion.action,
		message: state.completion.message,
	});
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

function makePayloadTransform(spec, promptText, envelope, roles) {
	return (body) => {
		if (spec.provider !== "openai-codex") {
			const messages = structuredClone(body.messages);
			if (envelope) {
				const promptIndex = messages.findIndex(
					(message) => message.role === "user" && textOf(message) === promptText,
				);
				if (promptIndex === -1) throw new Error("serialized head instruction not found");
				messages.splice(promptIndex + 1, 0, {
					role: "system",
					content: [{ type: "text", text: envelope }],
				});
			}
			roles.value = messages.slice(-4).map((message) => message.role).join(",");
			return { ...body, messages };
		}
		const input = structuredClone(body.input);
		const promptIndex = input.findIndex(
			(item) =>
				item?.role === "user" &&
				(item.content ?? []).some((block) => block?.type === "input_text" && block.text === promptText),
		);
		if (promptIndex === -1) throw new Error("serialized head instruction not found");
		input.splice(promptIndex + 1, 0, {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: envelope }],
		});
		roles.value = input.slice(-4).map((item) => item?.role ?? item?.type ?? "?").join(",");
		return { ...body, input };
	};
}

async function runOne(modelName, checkpoint, headName, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown ${spec.provider} model ${spec.id}`);
	const providerCurrent = arm === "provider-current";
	const actionJson = arm === "json-action-full-schema" || arm === "json-action-minimal";
	const deliveryActionJson = arm === "json-delivery-action";
	const commitPointJson = arm === "json-commit-point";
	const decisionSequenceJson = arm === "json-decision-sequence";
	const reviewRoutingJson = arm === "json-review-routing";
	const cacheSafeReviewRoutingJson = arm === "json-review-routing-cache-safe";
	const tagAwareReviewRoutingJson = arm === "json-review-routing-tag-aware";
	const messageFirstReviewRoutingJson = arm === "json-review-routing-message-first";
	const conclusiveNoneReviewRoutingJson = arm === "json-review-routing-conclusive-none";
	const assessedReviewRoutingJson = arm === "json-review-routing-assessed";
	const findingOnlyProbe = arm === "text-finding-only-probe";
	const priorFeedbackFindingOnly = arm === "text-finding-only-prior-feedback-bounded";
	const fixedSteerMessageFooterProbe = arm === "text-message-footer-fixed-steer-probe";
	const messageFooter = arm === "text-message-footer";
	const tagAwareMessageFooter = arm === "text-message-footer-tag-aware";
	const priorFeedbackMessageFooter = arm === "text-message-footer-prior-feedback";
	const strongRoutingPriorFeedbackMessageFooter =
		arm === "text-message-footer-prior-feedback-strong-route";
	const unifiedMessageFooter = arm === "text-message-footer-unified";
	const capabilitySchemaUnifiedMessageFooter =
		arm === "text-message-footer-unified-capability-schema";
	const boundedUnifiedMessageFooter = arm === "text-message-footer-unified-bounded";
	const recoveringUnifiedMessageFooter = arm === "text-message-footer-unified-recovery-bounded";
	const fullSchemaJson =
		arm === "json-full-schema" || arm === "json-full-schema-plain" || arm === "json-action-full-schema";
	const cacheAwareJson = arm === "json-cache-aware";
	const minimalJson =
		arm === "json-minimal" ||
		fullSchemaJson ||
		cacheAwareJson ||
		actionJson ||
		deliveryActionJson ||
		commitPointJson ||
		decisionSequenceJson ||
		reviewRoutingJson ||
		cacheSafeReviewRoutingJson ||
		tagAwareReviewRoutingJson ||
		messageFirstReviewRoutingJson ||
		conclusiveNoneReviewRoutingJson ||
		assessedReviewRoutingJson ||
		findingOnlyProbe ||
		priorFeedbackFindingOnly ||
		fixedSteerMessageFooterProbe ||
		messageFooter ||
		tagAwareMessageFooter ||
		priorFeedbackMessageFooter ||
		strongRoutingPriorFeedbackMessageFooter ||
		unifiedMessageFooter ||
		capabilitySchemaUnifiedMessageFooter ||
		boundedUnifiedMessageFooter ||
		recoveringUnifiedMessageFooter;
	const toolCompletion =
		!legacyCompletion &&
		(arm === "tool-treatment" ||
			arm === "tool-dedup" ||
			(providerCurrent && spec.provider === "openai-codex"));
	const productionJson = providerCurrent && spec.provider === "anthropic";
	const state = { completion: null };
	const rawLens = heads[headName];
	const priorFeedback = priorFeedbackFor(snapshots[checkpoint.id], headName);
	const combinedPrompt = findingOnlyProbe
		? buildFindingOnlyToolFreeObservationPrompt(headName, rawLens)
		: priorFeedbackFindingOnly
		? buildPriorFeedbackFindingOnlyObservationPrompt(headName, rawLens, priorFeedback)
		: fixedSteerMessageFooterProbe
		? buildFixedSteerMessageFooterToolFreeObservationPrompt(headName, rawLens)
		: boundedUnifiedMessageFooter || recoveringUnifiedMessageFooter || unifiedMessageFooter || capabilitySchemaUnifiedMessageFooter
		? buildUnifiedFooterToolFreeObservationPrompt(
				headName,
				rawLens,
				priorFeedback,
			)
		: strongRoutingPriorFeedbackMessageFooter
			? buildMessageFooterToolFreeObservationPrompt(headName, rawLens, {
					priorFeedback,
					strongRouting: true,
				})
		: priorFeedbackMessageFooter
			? buildMessageFooterToolFreeObservationPrompt(headName, rawLens, { priorFeedback })
		: messageFooter
			? buildMessageFooterToolFreeObservationPrompt(headName, rawLens)
		: minimalJson
			? buildToolFreeObservationPrompt(headName, rawLens, [])
		: productionJson
			? buildAnthropicObservationPrompt(headName, rawLens, [])
			: toolCompletion
				? buildObservationPrompt(headName, rawLens, [])
				: legacyCombinedPrompt(headName, rawLens);
	const split =
		spec.provider === "openai-codex" ||
		(spec.provider === "anthropic" && anthropicSplit && !productionJson);
	const promptText = split ? rawLens : combinedPrompt;
	const envelope = !split
		? undefined
		: priorFeedbackFindingOnly
			? buildPriorFeedbackFindingOnlyObservationEnvelope(headName, priorFeedback)
		: capabilitySchemaUnifiedMessageFooter || boundedUnifiedMessageFooter || recoveringUnifiedMessageFooter || unifiedMessageFooter
			? buildUnifiedFooterToolFreeObservationEnvelope(
					headName,
					priorFeedback,
				)
		: strongRoutingPriorFeedbackMessageFooter
			? buildStrongRoutingPriorFeedbackMessageFooterToolFreeObservationEnvelope(
					headName,
					priorFeedback,
				)
		: priorFeedbackMessageFooter
			? buildPriorFeedbackMessageFooterToolFreeObservationEnvelope(
					headName,
					priorFeedback,
				)
		: tagAwareMessageFooter
			? buildTagAwareMessageFooterToolFreeObservationEnvelope(headName)
		: messageFooter
			? buildMessageFooterToolFreeObservationEnvelope(headName)
		: findingOnlyProbe
			? buildFindingOnlyToolFreeObservationEnvelope(headName)
		: assessedReviewRoutingJson
			? buildAssessedReviewRoutingToolFreeObservationEnvelope(headName, [])
		: conclusiveNoneReviewRoutingJson
			? buildConclusiveNoneReviewRoutingToolFreeObservationEnvelope(headName, [])
		: messageFirstReviewRoutingJson
			? buildMessageFirstReviewRoutingToolFreeObservationEnvelope(headName, [])
		: tagAwareReviewRoutingJson
			? buildTagAwareReviewRoutingToolFreeObservationEnvelope(headName, [])
		: cacheSafeReviewRoutingJson
			? buildCacheSafeReviewRoutingToolFreeObservationEnvelope(headName, [])
		: reviewRoutingJson
			? buildReviewRoutingToolFreeObservationEnvelope(headName, [])
		: decisionSequenceJson
			? buildDecisionSequenceToolFreeObservationEnvelope(headName, [])
		: commitPointJson
			? buildCommitPointToolFreeObservationEnvelope(headName, [])
		: deliveryActionJson
			? buildDeliveryActionToolFreeObservationEnvelope(headName, [])
		: actionJson
			? buildActionToolFreeObservationEnvelope(headName, [])
		: arm === "json-full-schema" || cacheAwareJson
			? buildCacheAwareToolFreeObservationEnvelope(headName, [])
			: minimalJson
				? buildToolFreeObservationEnvelope(headName, [])
			: arm === "tool-dedup"
				? buildDeduplicatedToolEnvelope(headName, [])
				: toolCompletion
					? buildObservationEnvelope(headName, [])
					: legacySplitEnvelope(headName);
	const prompt = { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() };
	const tools = [
		fullSchemaJson
			? referenceOnlyHydraTool()
			: capabilitySchemaUnifiedMessageFooter
				? capabilityScopedManagementOnlyHydraTool()
			: minimalJson
			? managementOnlyHydraTool()
			: toolCompletion || productionJson
				? treatmentHydraTool(state)
				: legacyHydraTool(),
	];
	const context = {
		systemPrompt: `You are pi, a coding agent. Benchmark nonce: ${uuidv7()}.`,
		messages: snapshots[checkpoint.id],
		tools,
	};
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const roles = { value: "" };
	const onPayload = makePayloadTransform(spec, promptText, split ? envelope : undefined, roles);
	const options = {
		model,
		apiKey: auth[spec.provider].access,
		maxTokens: 700,
		reasoning,
		sessionId,
		transport: spec.provider === "openai-codex" ? "websocket" : undefined,
		onPayload,
	};

	try {
		// Exact first-request warmup. Its response is deliberately not added
		// to the measured context.
		const warmStarted = performance.now();
		await streamSimple(model, { ...context, messages: [...context.messages, prompt] }, options).result();
		const warmMs = Math.round(performance.now() - warmStarted);
		state.completion = null;
		const measuredStarted = performance.now();
		let providerCalls = 0;
			let messages = await runAgentLoop(
			[prompt],
			context,
			{
				...options,
				convertToLlm: (messages) => messages,
				onPayload: (body) => {
					providerCalls++;
					return onPayload(body);
				},
				beforeToolCall: async ({ assistantMessage, toolCall }) => {
					if (!toolCompletion || toolCall.name !== "hydra") return undefined;
					const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
					return calls.length === 1
						? undefined
						: { block: true, reason: "complete_observation must be the only tool call in its turn" };
				},
				shouldStopAfterTurn: () =>
					state.completion !== null ||
					((boundedUnifiedMessageFooter || recoveringUnifiedMessageFooter || priorFeedbackFindingOnly) && providerCalls >= 2),
			},
			() => {},
			undefined,
			streamSimple,
		);
			let response = [...messages].reverse().find((message) => message.role === "assistant");
			let responseText = state.completion ? completionText(state) : textOf(response);
			const parseStrictCompletion = (value) => minimalJson
				? capabilitySchemaUnifiedMessageFooter || boundedUnifiedMessageFooter || recoveringUnifiedMessageFooter || unifiedMessageFooter
					? parseUnifiedFooterDecision(value)
				: strongRoutingPriorFeedbackMessageFooter ||
					priorFeedbackMessageFooter ||
					tagAwareMessageFooter ||
					messageFooter ||
					fixedSteerMessageFooterProbe
					? parseMessageFooterDecision(value)
				: findingOnlyProbe || priorFeedbackFindingOnly
					? parseFindingOnlyProbe(value)
				: assessedReviewRoutingJson
					? parseAssessedDecision(value)
				: deliveryActionJson
					? parseDeliveryActionDecision(value)
					: actionJson
					? parseActionDecision(value)
					: parseToolFreeDecision(value)
				: null;
			let strictCompletion = parseStrictCompletion(responseText);
			const initialCompletionError = strictCompletion?.error ?? null;
			let recoveryAttempted = false;
			if (recoveringUnifiedMessageFooter && !strictCompletion?.decision && providerCalls < 2 && !response?.errorMessage) {
				recoveryAttempted = true;
				const correction = {
					role: "user",
					content: [{
						type: "text",
						text: `FORMAT CORRECTION: The preceding completion was rejected: ${strictCompletion?.error ?? "invalid format"}. Preserve its semantic decision and finding. Reply only with either DELIVERY: none as the entire response, or one concise message followed by a final DELIVERY: print|queue|steer|interrupt line.`,
					}],
					timestamp: Date.now(),
				};
				const recovered = await streamSimple(
					model,
					{ ...context, messages: [...context.messages, ...messages, correction] },
					{
						...options,
						onPayload: (body) => {
							providerCalls++;
							return onPayload(body);
						},
					},
				).result();
				messages = [...messages, correction, recovered];
				response = recovered;
				responseText = textOf(recovered);
				strictCompletion = parseStrictCompletion(responseText);
			}
			const decision =
			state.completion ?? (minimalJson ? strictCompletion?.decision ?? null : parseDecision(responseText));
		const usage = usageOf(messages);
		const expectedAction = checkpoint.expected[headName];
		const traceMessages = trace
			? messages
					.filter((message) => message.role === "assistant" || message.role === "toolResult")
					.map((message) =>
						message.role === "assistant"
							? {
									role: message.role,
									stopReason: message.stopReason,
									content: message.content.flatMap((block) =>
										block.type === "toolCall"
											? [{ tool: block.name, arguments: block.arguments }]
											: block.type === "text" && block.text
												? [{ text: block.text }]
												: [],
									),
								}
							: {
									role: message.role,
									tool: message.toolName,
									isError: message.isError,
									content: textOf(message),
								},
					)
			: undefined;
		return {
			model: modelName,
			modelId: spec.id,
			provider: spec.provider,
			thinking: reasoning,
			checkpoint: checkpoint.id,
			head: headName,
			sample,
			arm,
			expectedAction,
			ms: Math.round(performance.now() - measuredStarted),
			warmMs,
			providerCalls,
			extraTurns: Math.max(0, providerCalls - 1),
			roles: roles.value,
			stop: response?.stopReason ?? null,
			error: response?.errorMessage ?? null,
			completionValid: decision !== null,
				completionError: strictCompletion?.error ?? null,
				initialCompletionError,
				recoveryAttempted,
			action: decision?.action ?? null,
			actionCorrect: decision?.action === expectedAction,
			response: responseText,
			usage,
			hitRatio: hitRatio(usage),
			trace: traceMessages,
		};
	} finally {
		if (sessionId) closeOpenAICodexWebSocketSessions(sessionId);
	}
}

const completed = new Set();
if (existsSync(outputPath)) {
	for (const line of readFileSync(outputPath, "utf8").trim().split("\n").filter(Boolean)) {
		const row = JSON.parse(line);
		if (!retryErrors || !row.error) {
			completed.add(`${row.model}/${row.thinking}/${row.checkpoint}/${row.head}/${row.sample}/${row.arm}`);
		}
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const checkpoint of checkpoints) {
		if (requestedCheckpoints.length > 0 && !requestedCheckpoints.includes(checkpoint.id)) continue;
		for (const head of headNames) {
			if (requestedHeads.length > 0 && !requestedHeads.includes(head)) continue;
			if (requestedCases.length > 0 && !requestedCases.includes(`${checkpoint.id}/${head}`)) continue;
			for (let sample = sampleStart; sample <= samples; sample++) tasks.push({ model, checkpoint, head, sample });
		}
	}
}
for (let i = tasks.length - 1; i > 0; i--) {
	const j = Math.floor(Math.random() * (i + 1));
	[tasks[i], tasks[j]] = [tasks[j], tasks[i]];
}

console.error(
	`completion A/B: ${tasks.length} cases / ${tasks.length * requestedArms.length} measured calls; concurrency ${concurrency}; ${completed.size} already complete`,
);

let cursor = 0;
async function worker() {
	while (cursor < tasks.length) {
		const task = tasks[cursor++];
		const orderedArms = Math.random() < 0.5 ? requestedArms : [...requestedArms].reverse();
		for (const arm of orderedArms) {
			const key = `${task.model}/${reasoning}/${task.checkpoint.id}/${task.head}/${task.sample}/${arm}`;
			if (completed.has(key)) continue;
			try {
				const row = await runOne(task.model, task.checkpoint, task.head, task.sample, arm);
				appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
				console.log(
					`${key}: ${row.actionCorrect ? "PASS" : "FAIL"} ${row.action ?? "INVALID"} ${row.providerCalls} calls ${row.ms}ms CH${row.hitRatio.toFixed(1)}%`,
				);
			} catch (error) {
				const row = {
					model: task.model,
					thinking: reasoning,
					checkpoint: task.checkpoint.id,
					head: task.head,
					sample: task.sample,
					arm,
					error: error instanceof Error ? error.message : String(error),
				};
				appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
				console.error(`${key}: ERROR ${row.error}`);
			}
		}
	}
}

await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
