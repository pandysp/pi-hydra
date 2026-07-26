#!/usr/bin/env node
/**
 * Paired acting-head A/B for legacy JSON completion versus the enforceable
 * hydra action contract. The cases exercise file work, enforced post-write
 * delivery, head addition, and terminal self-removal in isolated workspaces.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { createEditTool, createLsTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import {
	applyAfterChangeDelivery,
	buildAnthropicObservationPrompt,
	buildObservationEnvelope,
	buildObservationPrompt,
	decisionFromCompletion,
	formatHeadManagementReceipt,
	parseDecision,
	parseHeadFile,
} from "../utils.ts";
import { hydraToolDescription, hydraToolParameters, validateHydraToolParams } from "../protocol.ts";
import { argOf } from "./lib.mjs";
import {
	buildDeduplicatedToolEnvelope,
	buildToolFreeObservationEnvelope,
	buildToolFreeObservationPrompt,
	managementOnlyHydraDescription,
	managementOnlyHydraParameters,
	parseToolFreeDecision,
	validateManagementOnlyParams,
} from "./tool-free-protocol.mjs";

const args = process.argv.slice(2);
const outputPath = argOf(args, "--output", "");
const samples = Number.parseInt(argOf(args, "--samples", "1"), 10);
const sampleStart = Number.parseInt(argOf(args, "--sample-start", "1"), 10);
const reasoning = argOf(args, "--thinking", "low");
const concurrency = Number.parseInt(argOf(args, "--concurrency", "2"), 10);
const retryErrors = args.includes("--retry-errors");
const legacyCompletion = args.includes("--legacy-completion");
const requestedModels = argOf(args, "--models", "luna,terra,sol").split(",").filter(Boolean);
const requestedArms = argOf(args, "--arms", "json-control,tool-treatment").split(",").filter(Boolean);
const requestedCases = argOf(args, "--cases", "").split(",").filter(Boolean);

if (!outputPath) throw new Error("--output is required");
if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
if (!Number.isInteger(sampleStart) || sampleStart < 1 || sampleStart > samples) {
	throw new Error("--sample-start must be between 1 and --samples");
}
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
const arms = ["json-control", "tool-treatment", "provider-current", "tool-dedup", "json-minimal"];
if (requestedArms.some((arm) => !arms.includes(arm))) throw new Error(`unknown arm: ${requestedArms.join(",")}`);

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

const auth = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"));
for (const provider of new Set(requestedModels.map((name) => modelSpecs[name].provider))) {
	const credential = auth[provider];
	if (!credential?.access || (typeof credential.expires === "number" && credential.expires < Date.now())) {
		throw new Error(`missing or expired ${provider} login; run pi and log in first`);
	}
}

const docsLens = `PURPOSE: Maintain docs/notes.md as durable memory for future work.
ACT WHEN: The trajectory establishes a new project decision or constraint that
is not already recorded.
WORK: Read docs/notes.md and add exactly one one-line entry. Edit nothing else.
DONE WHEN: The decision is recorded once.
DELIVER: The file is the work product; send no feedback.`;

const tunerLens = `PURPOSE: Improve other heads from the user's reactions.
ACT WHEN: The user dismisses, contradicts, or ignores another head's finding.
WORK: Sharpen that head's file by adding one clear boundary. Edit at most one
head and never your own.
DONE WHEN: The edited head excludes the rejected kind of finding.
DELIVER: Print the edit after changing a file; otherwise send no feedback.`;

const foremanLens = `PURPOSE: Keep the active heads matched to the work at hand.
ACT WHEN: The current phase or risks are not fully covered by the active heads,
or the foreman itself is no longer relevant.
WORK: Add fitting heads and remove irrelevant heads. Make the smallest crew
change that covers the trajectory.
DONE WHEN: The active heads cover current risks without irrelevant heads.
DELIVER: Make every real crew change visible with its reason; otherwise send no
feedback.`;

function write(root, path, content) {
	const absolute = join(root, path);
	mkdirSync(join(absolute, ".."), { recursive: true });
	writeFileSync(absolute, content);
}

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

function installHeads(root, names) {
	for (const name of names) {
		write(
			root,
			`.pi/hydra/${name}.md`,
			`---\nname: ${name}\ndescription: ${name} review\ntools: []\n---\nReview through a ${name} lens.\n`,
		);
	}
}

const cases = [
	{
		id: "docs-write-none",
		head: "docs-keeper",
		lens: docsLens,
		tools: ["read", "write", "edit", "ls"],
		afterChange: "noop",
		active: ["docs-keeper"],
		available: ["docs-keeper"],
		setup(root) {
			write(root, "docs/notes.md", "# Decisions\n");
		},
		trajectory: [
			["user", "Keep API retries at three and use exponential backoff. Implement that decision."],
			["assistant", "Implemented the retry policy and the integration tests pass."],
		],
		evaluate(run) {
			const notes = run.filesAfter["docs/notes.md"] ?? "";
			return /three|3/i.test(notes) && /exponential/i.test(notes) && run.changedFiles.join(",") === "docs/notes.md" && run.action === "noop";
		},
	},
	{
		id: "tuner-edit-print",
		head: "tuner",
		lens: tunerLens,
		tools: ["read", "write", "edit", "ls"],
		afterChange: "print",
		active: ["tuner"],
		available: ["tuner", "security"],
		setup(root) {
			write(root, "heads/security.md", "Review security risks including auth, injection, data exposure, naming, and style.\n");
			write(root, "heads/tuner.md", tunerLens);
		},
		trajectory: [
			["assistant", "[security] Rename parseToken to validateToken; the current name is misleading."],
			["user", "That is not a security issue. Stop raising naming and style comments from the security head."],
			["assistant", "Understood. I left the implementation unchanged."],
		],
		evaluate(run) {
			const security = run.filesAfter["heads/security.md"] ?? "";
			const narrowed = /naming|style/i.test(security) && /not|never|do not|avoid|exclude|ignore/i.test(security);
			return narrowed && run.changedFiles.join(",") === "heads/security.md" && run.action === "print";
		},
	},
	{
		id: "foreman-add-security",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		controlAfterChange: "print",
		active: ["foreman", "quality"],
		available: ["foreman", "quality", "security", "api-design"],
		setup(root) {
			installHeads(root, ["foreman", "quality", "security", "api-design"]);
		},
		trajectory: [
			["user", "Implementation of authentication and session handling starts now. Staff the active risks before coding."],
			["assistant", "I am beginning the authentication implementation."],
		],
		evaluate(run) {
			return (
				run.activeAfter.includes("security") &&
				run.receipts.length >= 1 &&
				(run.action === "noop" || run.action === "print")
			);
		},
	},
	{
		id: "foreman-self-remove",
		head: "foreman",
		lens: foremanLens,
		tools: ["hydra", "read"],
		afterChange: undefined,
		controlAfterChange: "print",
		active: ["foreman", "quality"],
		available: ["foreman", "quality", "security"],
		setup(root) {
			installHeads(root, ["foreman", "quality", "security"]);
		},
		trajectory: [
			["user", "Staffing is complete. Keep quality active, remove the foreman itself, and make no other crew changes."],
			["assistant", "The implementation phase can continue with quality alone."],
		],
		evaluate(run) {
			return !run.activeAfter.includes("foreman") && run.activeAfter.includes("quality") && run.selfRemoved && run.receipts.length === 1;
		},
	},
];

const selectedCases = requestedCases.length === 0 ? cases : cases.filter((testCase) => requestedCases.includes(testCase.id));
if (selectedCases.length !== (requestedCases.length || cases.length)) {
	throw new Error(`unknown case in: ${requestedCases.join(",")}`);
}

function assistant(text, model) {
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
			? assistant(text, model)
			: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
	);
}

const legacyShape =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';
function allowance(tools) {
	return `only these tools: ${tools.join(", ")}`;
}
function legacyCombinedPrompt(head, lens, tools, afterChange, active) {
	const change =
		afterChange === "print"
			? "After a successful state change, print a note describing it; the runtime enforces this delivery."
			: afterChange === "noop"
				? "Noop when your work product is the files you wrote."
				: "";
	const snapshot = tools.includes("hydra") ? ` Hydra snapshot at observation start: active heads are ${active.join(", ") || "none"}.` : "";
	return `<system-reminder>Side watcher with tool access.${snapshot} You may use ${allowance(tools)} to check facts or act on your lens. When done, reply with one JSON object, nothing else:
${legacyShape}

LENS: ${lens}

${change} Print a note the user sees but the agent does not. Queue findings that can wait. Steer findings between turns. Interrupt only for emergencies. Don't prefix message with [${head}].</system-reminder>`;
}
function legacySplitEnvelope(head, tools, afterChange, active) {
	const change =
		afterChange === "print"
			? "After a successful state change, print a note describing it; the runtime enforces this delivery."
			: afterChange === "noop"
				? "Noop when your work product is the files you wrote."
				: "";
	const snapshot = tools.includes("hydra") ? ` Hydra snapshot at observation start: active heads are ${active.join(", ") || "none"}.` : "";
	return `Side watcher with tool access. The preceding user message is the complete ${head} lens. The lens alone defines scope and when to act; do not broaden it.${snapshot} You may use ${allowance(tools)} to check facts or act on the lens. When done, reply with one JSON object, nothing else:
${legacyShape}

${change} Print a note the user sees but the agent does not. Queue findings that can wait. Steer findings between turns. Interrupt only for emergencies. Don't prefix message with [${head}].`;
}

const legacyHydraParameters = Type.Object({
	action: StringEnum(["add", "remove"]),
	head: Type.String(),
});

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

function refreshAvailable(root, state) {
	const directory = join(root, ".pi/hydra");
	if (!existsSync(directory)) return;
	for (const filename of readdirSync(directory)) {
		if (!filename.endsWith(".md")) continue;
		const parsed = parseHeadFile(readFileSync(join(directory, filename), "utf8"));
		if ("head" in parsed && !state.available.includes(parsed.head.name)) state.available.push(parsed.head.name);
	}
}

function manage(root, state, operation, rawName, message, modernManagement, observingHead) {
	refreshAvailable(root, state);
	const name = rawName.trim();
	const activeLabel = () => state.active.join(", ") || "none";
	const result = (text, changed = false, selfRemoved = false) => ({
		content: [{ type: "text", text }],
		details: { changed, operation, head: name },
		terminate: selfRemoved,
	});
	if (operation === "add") {
		if (!state.available.includes(name)) throw new Error(`Unknown head "${name}"`);
		if (state.active.includes(name)) return result(`"${name}" is already active. Observing with: ${activeLabel()}.`);
		state.active.push(name);
	} else {
		if (!state.active.includes(name)) return result(`"${name}" is not active. Observing with: ${activeLabel()}.`);
		state.active = state.active.filter((head) => head !== name);
	}
	const selfRemoved = operation === "remove" && name === observingHead;
	const receipt = modernManagement ? formatHeadManagementReceipt(operation, name, message) : "";
	if (modernManagement) state.receipts.push(receipt);
	state.selfRemoved ||= selfRemoved;
	return result(`${receipt ? `${receipt}\n` : ""}Observing with: ${activeLabel()}.`, true, modernManagement && selfRemoved);
}

function hydraTool(root, testCase, state, protocol) {
	if (protocol.minimalJson) {
		return {
			name: "hydra",
			label: "Hydra",
			description: managementOnlyHydraDescription(join(root, "heads")),
			parameters: managementOnlyHydraParameters,
			async execute(_id, rawParams) {
				if (!testCase.tools.includes("hydra")) {
					throw new Error(`Head "${testCase.head}" is not allowed to manage heads`);
				}
				const params = validateManagementOnlyParams(rawParams);
				return manage(root, state, params.operation, params.head, params.message, true, testCase.head);
			},
		};
	}
	if (protocol.modernManagement) {
		return {
				name: "hydra",
				label: "Hydra",
				// Match the isolated fixture's user-head path. The shared
				// description still names .pi/hydra as the project path.
				description: hydraToolDescription(join(root, "heads")),
				parameters: hydraToolParameters,
				async execute(_id, rawParams) {
					const params = validateHydraToolParams(rawParams);
					if (params.action === "manage_heads") {
						return manage(root, state, params.operation, params.head, params.message, true, testCase.head);
					}
					if (state.completion) throw new Error("complete_observation was already accepted");
					const decision = decisionFromCompletion(params.delivery, params.message);
					if (state.fileStateChanged && testCase.afterChange === "print" && decision.action !== "print") {
						throw new Error('This head requires delivery "print" after a successful write or edit');
					}
					if (state.fileStateChanged && testCase.afterChange === "noop" && decision.action !== "noop") {
						throw new Error('This head requires delivery "none" after a successful write or edit');
					}
					state.completion = decision;
					return {
						content: [{ type: "text", text: "Observation completed." }],
						details: { changed: false },
						terminate: true,
					};
				},
			};
	}
	return {
		name: "hydra",
		label: "Hydra",
		description: legacyHydraDescription(join(root, "heads")),
		parameters: legacyHydraParameters,
		async execute(_id, params) {
			if (!testCase.tools.includes("hydra")) {
				throw new Error(`Head "${testCase.head}" is not allowed to manage heads`);
			}
			return manage(root, state, params.action, params.head, "", false, testCase.head);
		},
	};
}

function toolsFor(root, testCase, state, protocol) {
	const standard = [createReadTool(root), createWriteTool(root), createEditTool(root), createLsTool(root)].filter((tool) =>
		testCase.tools.includes(tool.name),
	);
	return [...standard, hydraTool(root, testCase, state, protocol)];
}

function textOf(message) {
	return (message?.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("");
}
function itemText(item) {
	return (item?.content ?? []).filter((block) => block?.type === "input_text").map((block) => block.text).join("");
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

async function runOne(modelName, testCase, sample, arm) {
	const spec = modelSpecs[modelName];
	const model = getModel(spec.provider, spec.id);
	if (!model) throw new Error(`unknown model ${spec.provider}/${spec.id}`);
	const providerCurrent = arm === "provider-current";
	const minimalJson = arm === "json-minimal";
	const toolCompletion =
		!legacyCompletion &&
		(arm === "tool-treatment" ||
			arm === "tool-dedup" ||
			(providerCurrent && spec.provider === "openai-codex"));
	const productionJson = providerCurrent && spec.provider === "anthropic";
	const protocol = {
		minimalJson,
		toolCompletion,
		productionJson,
		modernManagement: minimalJson || toolCompletion || productionJson,
	};
	const root = mkdtempSync(join(tmpdir(), `hydra-completion-${modelName}-${testCase.id}-${sample}-${arm}-`));
	testCase.setup(root);
	const filesBefore = snapshot(root);
	const state = {
		active: [...testCase.active],
		available: [...testCase.available],
		completion: null,
		receipts: [],
		selfRemoved: false,
		fileStateChanged: false,
	};
	const afterChange = protocol.modernManagement
		? testCase.afterChange
		: testCase.controlAfterChange ?? testCase.afterChange;
	const promptOptions = { afterChange, activeHeads: testCase.active };
	const combinedPrompt = minimalJson
		? buildToolFreeObservationPrompt(testCase.head, testCase.lens, testCase.tools, promptOptions)
		: productionJson
			? buildAnthropicObservationPrompt(testCase.head, testCase.lens, testCase.tools, promptOptions)
			: toolCompletion
				? buildObservationPrompt(testCase.head, testCase.lens, testCase.tools, {
				afterChange,
				activeHeads: testCase.active,
			})
				: legacyCombinedPrompt(testCase.head, testCase.lens, testCase.tools, afterChange, testCase.active);
	const promptText = spec.provider === "openai-codex" ? testCase.lens : combinedPrompt;
	const envelope =
		spec.provider !== "openai-codex"
			? undefined
			: minimalJson
				? buildToolFreeObservationEnvelope(testCase.head, testCase.tools, promptOptions)
				: arm === "tool-dedup"
					? buildDeduplicatedToolEnvelope(testCase.head, testCase.tools, promptOptions)
					: toolCompletion
						? buildObservationEnvelope(testCase.head, testCase.tools, promptOptions)
						: legacySplitEnvelope(testCase.head, testCase.tools, afterChange, testCase.active);
	const prompt = { role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() };
	const context = {
		systemPrompt: `You are pi, a coding agent. The working directory is ${root}. Benchmark nonce: ${uuidv7()}.`,
		messages: trajectoryMessages(testCase.trajectory, model),
		tools: toolsFor(root, testCase, state, protocol),
	};
	const sessionId = spec.provider === "openai-codex" ? uuidv7() : undefined;
	const roles = { value: "" };
	const onPayload = (body) => {
		if (spec.provider !== "openai-codex") {
			roles.value = body.messages.slice(-8).map((message) => message.role).join(",");
			return body;
		}
		const input = structuredClone(body.input);
		const promptIndex = input.findIndex((item) => item?.role === "user" && itemText(item) === promptText);
		if (promptIndex === -1) throw new Error("serialized head instruction not found");
		input.splice(promptIndex + 1, 0, {
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: envelope }],
		});
		roles.value = input.slice(-8).map((item) => item?.role ?? item?.type ?? "?").join(",");
		return { ...body, input };
	};
	const options = {
		model,
		apiKey: auth[spec.provider].access,
		maxTokens: 1800,
		reasoning,
		sessionId,
		transport: spec.provider === "openai-codex" ? "websocket" : undefined,
		onPayload,
	};
	try {
		const warmStarted = performance.now();
		await streamSimple(model, { ...context, messages: [...context.messages, prompt] }, options).result();
		const warmMs = Math.round(performance.now() - warmStarted);
		state.completion = null;
		state.receipts = [];
		state.selfRemoved = false;
		state.fileStateChanged = false;
		let providerCalls = 0;
		const events = [];
		const measuredStarted = performance.now();
		const messages = await runAgentLoop(
			[prompt],
			context,
			{
				...options,
				convertToLlm: (messages) => messages,
				onPayload: (body) => {
					providerCalls++;
					return onPayload(body);
				},
				beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
					if (
						!protocol.modernManagement ||
						toolCall.name !== "hydra" ||
						typeof args !== "object" ||
						args === null
					) {
						return undefined;
					}
					const terminal =
						args.action === "complete_observation" ||
						(args.action === "manage_heads" &&
							args.operation === "remove" &&
							typeof args.head === "string" &&
							args.head.trim() === testCase.head);
					if (!terminal) return undefined;
					const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
					return calls.length === 1
						? undefined
						: { block: true, reason: "Terminal hydra actions must be the only tool call in their turn" };
				},
				afterToolCall: async (event) => {
					events.push({ name: event.toolCall.name, args: event.toolCall.arguments, isError: event.isError });
					if (!event.isError && (event.toolCall.name === "write" || event.toolCall.name === "edit")) {
						state.fileStateChanged = true;
					}
					return undefined;
				},
				shouldStopAfterTurn: ({ newMessages }) =>
					(protocol.modernManagement && (state.completion !== null || state.selfRemoved)) ||
					newMessages.filter((message) => message.role === "assistant").length >= 10,
			},
			() => {},
			undefined,
			streamSimple,
		);
		const response = [...messages].reverse().find((message) => message.role === "assistant");
		const responseText = textOf(response);
		const strictCompletion =
			minimalJson && !state.selfRemoved ? parseToolFreeDecision(responseText) : null;
		let decision =
			state.completion ?? (minimalJson ? strictCompletion?.decision ?? null : parseDecision(responseText));
		const filesAfter = snapshot(root);
		const changedFiles = [...new Set([...Object.keys(filesBefore), ...Object.keys(filesAfter)])]
			.filter((path) => filesBefore[path] !== filesAfter[path])
			.sort();
		const stateChanged = changedFiles.length > 0 || state.active.join(",") !== testCase.active.join(",");
		if ((!toolCompletion || legacyCompletion) && decision) {
			decision = applyAfterChangeDelivery(decision, afterChange, stateChanged);
		}
		if (protocol.modernManagement && !decision && state.selfRemoved) {
			decision = { action: "noop", reason: "completed by self-removal", message: "" };
		}
		const receipts =
			protocol.modernManagement || !stateChanged || decision?.action !== "print"
				? state.receipts
				: [decision.message || "State changed."];
		const run = {
			filesAfter,
			changedFiles,
			activeAfter: state.active,
			action: decision?.action ?? null,
			receipts,
			selfRemoved: state.selfRemoved,
		};
		const usage = usageOf(messages);
		return {
			model: modelName,
			modelId: model.id,
			provider: spec.provider,
			thinking: reasoning,
			case: testCase.id,
			head: testCase.head,
			sample,
			arm,
			ms: Math.round(performance.now() - measuredStarted),
			warmMs,
			providerCalls,
			extraTurns: Math.max(0, providerCalls - 1),
			roles: roles.value,
			stop: response?.stopReason ?? null,
			error: response?.errorMessage ?? null,
			completionValid: minimalJson
				? strictCompletion?.decision !== null || state.selfRemoved
				: toolCompletion && !legacyCompletion
					? state.completion !== null || state.selfRemoved
					: decision !== null || state.selfRemoved,
			completionError: strictCompletion?.error ?? null,
			action: decision?.action ?? null,
			stateChanged,
			selfRemoved: state.selfRemoved,
			receipts,
			toolCalls: events,
			filesBefore,
			filesAfter,
			changedFiles,
			activeBefore: testCase.active,
			activeAfter: state.active,
			correct: testCase.evaluate(run),
			usage,
			hitRatio: hitRatio(usage),
			response: toolCompletion && !legacyCompletion
				? state.completion
					? JSON.stringify({
							action: "complete_observation",
							delivery: state.completion.action === "noop" ? "none" : state.completion.action,
							message: state.completion.message,
						})
					: ""
				: responseText,
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
		if (!retryErrors || !row.error) {
			completed.add(`${row.model}/${row.thinking}/${row.case}/${row.sample}/${row.arm}`);
		}
	}
}

const tasks = [];
for (const model of requestedModels) {
	for (const testCase of selectedCases) {
		for (let sample = sampleStart; sample <= samples; sample++) tasks.push({ model, testCase, sample });
	}
}
for (let i = tasks.length - 1; i > 0; i--) {
	const j = Math.floor(Math.random() * (i + 1));
	[tasks[i], tasks[j]] = [tasks[j], tasks[i]];
}

console.error(
	`completion acting A/B: ${tasks.length} cases / ${tasks.length * requestedArms.length} measured calls; concurrency ${concurrency}; ${completed.size} already complete`,
);
let cursor = 0;
async function worker() {
	while (cursor < tasks.length) {
		const task = tasks[cursor++];
		const orderedArms = Math.random() < 0.5 ? requestedArms : [...requestedArms].reverse();
		for (const arm of orderedArms) {
			const key = `${task.model}/${reasoning}/${task.testCase.id}/${task.sample}/${arm}`;
			if (completed.has(key)) continue;
			try {
				const row = await runOne(task.model, task.testCase, task.sample, arm);
				appendFileSync(outputPath, `${JSON.stringify(row)}\n`);
				console.log(
					`${key}: ${row.correct ? "PASS" : "FAIL"} ${row.action ?? "INVALID"} ${row.providerCalls} calls ${row.ms}ms CH${row.hitRatio.toFixed(1)}%`,
				);
			} catch (error) {
				const row = {
					model: task.model,
					thinking: reasoning,
					case: task.testCase.id,
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
