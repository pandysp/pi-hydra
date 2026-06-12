/**
 * hydra: commit-point observer for pi.
 *
 * Watches the driver's conversation through a side model that replays the
 * driver's exact provider payload with one observer prompt appended. Because
 * the prefix is byte-identical, every observation is a prompt-cache read of
 * the entry the driver itself just wrote (97%+ hit ratio). The observer
 * answers with a JSON decision (noop, queue, steer, or interrupt) which
 * hydra routes back into the session.
 *
 * A custom lens marked `tools: true` is an acting head: before deciding, it
 * may run the driver's own tools through pi's agent loop (a docs head keeps
 * notes current while the driver works, a research head looks something up
 * and steers the finding in). Every loop call replays the same byte-true
 * prefix; every file write is announced to the session.
 *
 * Observations fire at the driver's own cache commit points (see
 * experiments/README.md for the empirical basis):
 *
 * - Piggyback (mid-run): when a driver response begins streaming, the request
 *   that produced it has just been committed to the cache. Replaying that
 *   request is a pure cache read, fresh through the latest tool results.
 * - Run-end (agent_end): no further driver request will carry the final
 *   assistant message M into the cache, so the observer appends M itself,
 *   serialized by pi-ai's own provider code via the onPayload hook, and
 *   moves the driver's message-level cache marker onto it. The fork pays M's
 *   write once and pre-warms the driver's next, human-paced turn.
 *
 * Usage:
 *   pi install /path/to/pi-hydra   (or symlink into ~/.pi/agent/extensions)
 *   /hydra            toggle the observer
 *   /hydra-lens       pick the lens set, comma-separated (built-in + custom)
 *   /hydra-delivery   pick how findings reach you (print, queue, steer, interrupt)
 *   /hydra-stats      cache hit ratio, cost, and recent decisions
 *   /hydra-debug      dump driver/observer payload pairs for diffing
 *
 * The agent can manage its own heads through the registered `hydra` tool
 * (list, set-lenses, write-lens, remove-lens). Delivery mode, /hydra, and
 * pi's extension management stay user-level controls: the agent shapes what
 * its observers look for, never how forcefully they reach the session.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { complete, StringEnum, Type } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Model, Static, ToolCall } from "@earendil-works/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { Action, AnthropicPayload, Decision, DeliveryMode, LensDefinition, ObserverUsage } from "./utils";
import {
	buildLensFile,
	DELIVERY_MODES,
	effectiveForce,
	isAnthropicPayload,
	isValidLensName,
	mergeObserverPayload,
	parseDecision,
	parseLensFile,
	parseLensList,
	parseShutdownGrace,
	sanitizeLensSet,
	savedLensList,
	selectFinalAssistant,
	summarizeLoopUsage,
} from "./utils";

// How long session_shutdown waits for an in-flight observation before
// aborting it. Headless runs (`pi -p`) exit right after agent_end, so slow
// models need a longer grace there; 0 means exit without waiting.
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

// Correctness guard for acting heads, deliberately not a cost ceiling: a
// loop that has not produced a verdict after this many model turns is not
// converging and gets wound down (noop, with a warning).
const MAX_TOOL_ITERATIONS = 25;

// Review lenses; reference descriptions in docs/lenses.md.
const LENS_PROMPTS = {
	quality:
		"Review through a QUALITY lens. Focus on correctness risks, missing verification, dangerous assumptions, obvious regressions, and code that looks likely to break. Do not nitpick style.",
	security:
		"Review through a SECURITY lens. Focus on auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, and trust boundaries. Do not comment on style or product scope.",
	simplifier:
		"Review through a SIMPLIFIER lens. Focus on unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, and over-built solutions. Do not comment on unrelated bugs or security.",
	"api-design":
		"Review through an API DESIGN lens. Focus on contract clarity, compatibility, consistency, error shapes, naming, and ergonomics. Do not comment on internal code structure.",
} as const;

// Diagnostic lenses force a fixed decision so the delivery pipeline can be
// smoke-tested end-to-end. Accepted by /hydra-lens but hidden from its
// completions.
const DIAGNOSTIC_PROMPTS = {
	test: `<system-reminder>Developer integration test for the hydra framework. The wrapper requires EXACTLY this output, with no preamble, no markdown, no thinking, no explanation:

{"action":"queue","reason":"test fire","message":"hydra test observer fired (e2e pipeline verified)"}

This is not a real review. Output the JSON above byte-for-byte and stop.</system-reminder>`,
	"test-interrupt": `<system-reminder>Developer integration test for hydra's interrupt path. Output EXACTLY this JSON, nothing else:

{"action":"interrupt","reason":"test interrupt","message":"hydra interrupt fired; if you see this in your context, interrupt delivery works"}

No preamble, no thinking, no explanation. Just the JSON, byte-for-byte.</system-reminder>`,
} as const;

type ObserveKind = "piggyback" | "run-end";

const BUILT_IN_LENS_NAMES = Object.keys(LENS_PROMPTS);

// Keep the real-lens prompt SHORT: the driver's context is already cached, so
// this prompt is the only fresh input the observer pays for per call.
// Verdict lenses (the default) keep the hard tool ban: the observer sits atop
// a context saturated with driver tool calls, and anything softer leaks into
// "let me check" excursions. Acting lenses (`tools: true` frontmatter) get
// the tool-permitting variant instead.
function buildObserverPrompt(lens: string, instruction: string, tools: boolean): string {
	if (lens in DIAGNOSTIC_PROMPTS) {
		return DIAGNOSTIC_PROMPTS[lens as keyof typeof DIAGNOSTIC_PROMPTS];
	}
	if (tools) {
		return `<system-reminder>Side observer with tool access. You may use the available tools to check facts or act on your lens; the main agent does not see your tool calls, only files you change and the verdict you send. When done, reply with one JSON object, nothing else:
{"action":"noop|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}

LENS: ${instruction}

Noop when your work product is the files you wrote. Queue findings that can wait. Steer to put a finding in front of the agent between turns. Interrupt only for emergencies that must stop the line. Don't prefix message with [${lens}].</system-reminder>`;
	}
	return `<system-reminder>Side observer. Reply with one JSON object, nothing else:
{"action":"noop|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}

LENS: ${instruction}

Noop unless something warrants feedback. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${lens}].</system-reminder>`;
}

// One observer call, persisted to the session as a custom "hydra-call" entry
// so /hydra-stats survives resume and branch navigation.
interface HydraCall {
	timestamp: number;
	turnIndex: number;
	lens: string;
	kind?: ObserveKind;
	action: Action;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	// Replay-parity signal, always from the observation's first model call:
	// an acting head's later loop iterations legitimately pay the growing
	// tail as fresh input and must not read as a cache regression.
	hitRatio: number;
	rawResponse?: string;
	// Acting heads only: model turns in the tool loop and the tools executed.
	iterations?: number;
	toolsUsed?: string[];
}

interface Observation {
	ctx: ExtensionContext;
	payload: unknown;
	assistant: AssistantMessage | null;
	turnIndex: number;
	lens: string;
	prompt: string; // resolved at scheduling time, so lens edits never race an in-flight job
	tools: boolean; // acting head: may run tool calls before its verdict
	kind: ObserveKind;
}

interface FeedbackDetails {
	lens: string;
	action: Action;
	reason: string;
	deliveryMode: DeliveryMode;
}

// Lens set, delivery mode, and enabled survive resume and branch navigation
// as the latest "hydra-config" entry on the branch. CLI flags seed sessions
// that have no persisted config yet (the only way to configure headless
// `pi -p` runs, which cannot issue slash commands). `lens` is the pre-multi-
// head field name, still read for old sessions.
interface HydraConfig {
	lenses: string[];
	deliveryMode: DeliveryMode;
	enabled: boolean;
	lens?: string;
}

const MAX_DELIVERED_KEYS = 200;

export default function hydraExtension(pi: ExtensionAPI) {
	let enabled = true;
	// The active lens set: one observation fans out per lens, in parallel.
	// Either a single diagnostic lens or any number of product lenses; the
	// two never mix, since the diagnostics' one-shot revert restores
	// productLenses.
	let lenses: string[] = ["quality"];
	let productLenses: string[] = ["quality"];
	let deliveryMode: DeliveryMode = "steer";

	pi.registerFlag("hydra-lens", {
		description: `Initial hydra lens set, comma-separated (${BUILT_IN_LENS_NAMES.join("|")} or custom)`,
		type: "string",
	});
	pi.registerFlag("hydra-delivery", {
		description: "Initial hydra delivery mode (print|queue|steer|interrupt)",
		type: "string",
	});
	pi.registerFlag("hydra-off", {
		description: "Start with the hydra observer disabled",
		type: "boolean",
		default: false,
	});

	// Custom lenses: one markdown file per lens in ~/.pi/agent/hydra/lenses
	// (filename = lens name, optional frontmatter description, body = the lens
	// instruction). Re-read at every agent_start, so editing a lens applies to
	// the next run without a reload. A custom lens may override a built-in by
	// name; the diagnostic lenses are not overridable.
	const lensDir = join(getAgentDir(), "hydra", "lenses");
	let customLenses = new Map<string, LensDefinition>();

	function discoverLenses(ctx: ExtensionContext) {
		const found = new Map<string, LensDefinition>();
		let files: string[];
		try {
			files = readdirSync(lensDir);
		} catch {
			customLenses = found; // no directory means no custom lenses
			return;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) {
				continue;
			}
			const name = file.slice(0, -".md".length);
			if (name in DIAGNOSTIC_PROMPTS) {
				continue;
			}
			try {
				const definition = parseLensFile(name, readFileSync(join(lensDir, file), "utf8"));
				if (definition) {
					found.set(name, definition);
				}
			} catch (error) {
				ctx.ui.notify(`hydra: failed to read lens ${file}: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}
		customLenses = found;
	}

	function lensExists(name: string): boolean {
		return name in LENS_PROMPTS || name in DIAGNOSTIC_PROMPTS || customLenses.has(name);
	}

	function lensNames(): string[] {
		return [...new Set([...BUILT_IN_LENS_NAMES, ...customLenses.keys()])].sort();
	}

	const lensCatalog = {
		exists: (name: string) => lensExists(name),
		isDiagnostic: (name: string) => name in DIAGNOSTIC_PROMPTS,
	};

	// Apply a lens set from any surface (command, flag, tool). Returns false
	// when nothing valid was requested; the current set stays in place.
	function setLensSet(ctx: ExtensionContext, requested: string[]): boolean {
		const next = sanitizeLensSet(requested, lensCatalog);
		if (next.unknown.length > 0) {
			ctx.ui.notify(`hydra: unknown lens: ${next.unknown.join(", ")}. valid: ${lensNames().join(", ")}`, "warning");
		}
		if (next.lenses.length === 0) {
			return false;
		}
		lenses = next.lenses;
		if (!next.lenses.some((name) => name in DIAGNOSTIC_PROMPTS)) {
			productLenses = next.lenses;
		}
		persistConfig();
		updateFooter(ctx);
		return true;
	}

	function observerPromptFor(name: string, tools: boolean): string {
		const instruction =
			customLenses.get(name)?.prompt ?? LENS_PROMPTS[name as keyof typeof LENS_PROMPTS] ?? LENS_PROMPTS.quality;
		return buildObserverPrompt(name, instruction, tools);
	}

	// Only a custom lens can declare itself an acting head; built-ins and
	// diagnostics are verdict-only by definition.
	function lensUsesTools(name: string): boolean {
		return customLenses.get(name)?.tools === true;
	}

	// Driver capture: the exact provider payload of the most recent request,
	// plus enough run state to know what it represents. responseTimestamp is
	// the timestamp of the captured request's own response, recorded at its
	// message_start; the run-end trigger matches M against it by identity (an
	// older message is already serialized inside the payload).
	let capturedPayload: unknown = null;
	let responseTimestamp: number | null = null;
	let capturedThisRun = false;
	let awaitingFirstResponseOfRun = true;
	let currentTurnIndex = 0;

	// Conflating single-slot scheduler, per head: every lens has at most one
	// observation in flight and one waiting slot that a newer snapshot
	// overwrites. Observations always run to completion; staleness is bounded
	// to one cycle because the slot always holds the newest snapshot. The
	// granularity is per head (not one global batch) so an acting head's
	// minutes-long tool loop cannot starve the verdict heads, and a head busy
	// through a commit point still reviews the newest snapshot when it frees
	// up. session_shutdown awaits the in-flight runs.
	interface Head {
		pending: Observation | null;
		running: Promise<void> | null;
	}
	const heads = new Map<string, Head>();
	const lifecycleAbort = new AbortController();

	// Stats, rebuilt from the current session branch on restore.
	let calls: HydraCall[] = [];
	const delivered = new Set<string>();
	const warnedProviders = new Set<string>();
	let debugDir: string | null = null;

	function cumulative() {
		let cost = 0;
		let read = 0;
		let write = 0;
		let input = 0;
		for (const call of calls) {
			cost += call.cost;
			read += call.cacheRead;
			write += call.cacheWrite;
			input += call.input;
		}
		const readable = read + write + input;
		return { cost, read, write, input, meanHit: readable > 0 ? (read / readable) * 100 : 0 };
	}

	function updateFooter(ctx: ExtensionContext) {
		if (!enabled) {
			ctx.ui.setStatus("hydra", undefined);
			return;
		}
		const lensLabel = lenses.length > 0 ? lenses.join("+") : "no heads";
		if (calls.length === 0) {
			ctx.ui.setStatus("hydra", ctx.ui.theme.fg("muted", `hydra: ${lensLabel} | ${deliveryMode} | (no obs yet)`));
			return;
		}
		const { cost, meanHit } = cumulative();
		const lastHit = calls[calls.length - 1].hitRatio;
		const hitColor = meanHit >= 97 ? "success" : meanHit >= 90 ? "warning" : "error";
		ctx.ui.setStatus(
			"hydra",
			ctx.ui.theme.fg("toolTitle", `hydra:${lensLabel}`) +
				" " +
				ctx.ui.theme.fg("muted", deliveryMode) +
				" " +
				ctx.ui.theme.fg(hitColor, `hit ${meanHit.toFixed(1)}% (last ${lastHit.toFixed(1)}%)`) +
				" " +
				ctx.ui.theme.fg("dim", `$${cost.toFixed(4)} (${calls.length} obs)`),
		);
	}

	function persistConfig() {
		pi.appendEntry<HydraConfig>("hydra-config", { lenses, deliveryMode, enabled });
	}

	function applyConfig(ctx: ExtensionContext, config: HydraConfig) {
		enabled = config.enabled;
		if (DELIVERY_MODES.includes(config.deliveryMode)) {
			deliveryMode = config.deliveryMode;
		}
		const saved = savedLensList(config);
		if (saved === null) {
			return;
		}
		if (saved.length === 0) {
			// A deliberately emptied set (all heads removed) is respected on restore.
			lenses = [];
			productLenses = [];
			return;
		}
		const next = sanitizeLensSet(saved, lensCatalog);
		if (next.unknown.length > 0) {
			ctx.ui.notify(`hydra: saved lens no longer exists: ${next.unknown.join(", ")}`, "warning");
		}
		if (next.lenses.length > 0) {
			lenses = next.lenses;
			if (!next.lenses.some((name) => name in DIAGNOSTIC_PROMPTS)) {
				productLenses = next.lenses;
			}
		}
	}

	// CLI flags seed fresh sessions only; once a config entry exists on the
	// branch, the persisted settings win. Seeded settings persist like any
	// other settings change, so they survive resume.
	function applyFlags(ctx: ExtensionContext) {
		let applied = false;
		const flagLens = pi.getFlag("hydra-lens");
		if (typeof flagLens === "string" && flagLens.length > 0) {
			// setLensSet persists on success; the remaining flags persist below.
			setLensSet(ctx, parseLensList(flagLens));
		}
		const flagDelivery = pi.getFlag("hydra-delivery");
		if (typeof flagDelivery === "string" && flagDelivery.length > 0) {
			if ((DELIVERY_MODES as string[]).includes(flagDelivery)) {
				deliveryMode = flagDelivery as DeliveryMode;
				applied = true;
			} else {
				ctx.ui.notify(`hydra: unknown mode in --hydra-delivery: ${flagDelivery}`, "warning");
			}
		}
		if (pi.getFlag("hydra-off") === true) {
			enabled = false;
			applied = true;
		}
		if (applied) {
			persistConfig();
		}
	}

	function restoreFromBranch(ctx: ExtensionContext): boolean {
		calls = [];
		let config: HydraConfig | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") {
				continue;
			}
			if (entry.customType === "hydra-call") {
				const data = entry.data as HydraCall | undefined;
				if (data && typeof data === "object") {
					calls.push(data);
				}
			} else if (entry.customType === "hydra-config") {
				const data = entry.data as HydraConfig | undefined;
				if (data && typeof data === "object") {
					config = data;
				}
			}
		}
		if (config) {
			applyConfig(ctx, config);
		}
		updateFooter(ctx);
		return config !== undefined;
	}

	// One observation's outcome, the same shape for both head kinds: a
	// verdict head is the single-call case.
	interface ObserveOutcome {
		response: AssistantMessage;
		usages: ObserverUsage[];
		iterations: number;
		toolsUsed: string[];
	}

	function flattenUsage(usage: AssistantMessage["usage"]): ObserverUsage {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost.total,
		};
	}

	async function observe(job: Observation, signal: AbortSignal) {
		const model = job.ctx.model;
		if (!model) {
			return;
		}
		// Cache-parity replay is validated on Anthropic's Messages API only.
		if (model.provider !== "anthropic") {
			if (!warnedProviders.has(model.provider)) {
				warnedProviders.add(model.provider);
				job.ctx.ui.notify(
					`hydra: observations disabled for provider "${model.provider}" (cache-parity replay is validated on Anthropic only)`,
					"warning",
				);
			}
			return;
		}
		if (!isAnthropicPayload(job.payload)) {
			return;
		}
		const captured = job.payload;

		const auth = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const reason = auth.ok ? "no API key" : auth.error;
			job.ctx.ui.notify(`hydra: no credentials for ${model.provider}: ${reason}`, "warning");
			return;
		}

		// Run-end observations carry M so pi-ai's own provider code serializes
		// it; piggyback payloads already contain everything. The onPayload hook
		// receives pi-ai's serialization of these messages and splices it onto
		// the captured prefix; see mergeObserverPayload for the cache story.
		const prompt: Message = {
			role: "user",
			content: [{ type: "text", text: job.prompt }],
			timestamp: Date.now(),
		};
		const onPayload = (built: unknown) => {
			if (!isAnthropicPayload(built)) {
				throw new Error(`unexpected payload shape from provider ${model.provider}`);
			}
			const merged = mergeObserverPayload(captured, built.messages);
			if (debugDir) {
				const stamp = Date.now();
				writeFileSync(join(debugDir, `hydra-driver-${stamp}.json`), JSON.stringify(captured, null, 2));
				writeFileSync(join(debugDir, `hydra-observer-${stamp}.json`), JSON.stringify(merged, null, 2));
			}
			return merged;
		};

		const t0 = Date.now();
		const outcome = job.tools
			? await observeWithTools(job, model, auth.apiKey, auth.headers, prompt, onPayload, signal)
			: await observeVerdict(job, model, auth.apiKey, auth.headers, prompt, onPayload, signal);
		if (!outcome || signal.aborted) {
			return;
		}
		const { response, usages, iterations, toolsUsed } = outcome;
		const summary = summarizeLoopUsage(usages);

		// A zero-usage, zero-content response is a provider hiccup (e.g. an
		// overload surfaced as an empty result), not an observation.
		if (summary.input + summary.cacheRead + summary.cacheWrite === 0 && response.content.length === 0) {
			job.ctx.ui.notify("hydra: observer call returned empty response (provider overloaded?)", "warning");
			return;
		}

		const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		// An acting head can stop before its verdict (iteration guard, or
		// /hydra toggled off mid-loop); record that honestly instead of
		// "unparseable response".
		const decision: Decision =
			response.stopReason === "toolUse"
				? { action: "noop", reason: "loop stopped before verdict", message: "" }
				: parseDecision(text);

		const call: HydraCall = {
			timestamp: Date.now(),
			turnIndex: job.turnIndex,
			lens: job.lens,
			kind: job.kind,
			action: decision.action,
			input: summary.input,
			output: summary.output,
			cacheRead: summary.cacheRead,
			cacheWrite: summary.cacheWrite,
			cost: summary.cost,
			durationMs: Date.now() - t0,
			hitRatio: summary.hitRatio,
			rawResponse: text.length > 200 ? `${text.slice(0, 200)}…` : text,
			iterations: job.tools ? iterations : undefined,
			toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
		};
		calls.push(call);
		pi.appendEntry<HydraCall>("hydra-call", call);

		// Diagnostic lenses are one-shot: revert before routing, otherwise an
		// interrupt delivery re-triggers itself forever (each injected message
		// starts a run whose run-end observation would interrupt again).
		if (job.lens in DIAGNOSTIC_PROMPTS && lenses.length === 1 && lenses[0] === job.lens) {
			lenses = productLenses;
			persistConfig();
			job.ctx.ui.notify(`hydra: diagnostic lens "${job.lens}" fired once; reverting to ${productLenses.join("+")}`, "info");
		}
		updateFooter(job.ctx);

		// A verdict formed on an outdated snapshot may steer but no longer
		// abort: the driver has already moved on.
		routeDecision(job.ctx, decision, job.lens, job.payload !== capturedPayload);
	}

	async function observeVerdict(
		job: Observation,
		model: Model<"anthropic-messages">,
		apiKey: string,
		headers: Record<string, string> | undefined,
		prompt: Message,
		onPayload: (built: unknown) => unknown,
		signal: AbortSignal,
	): Promise<ObserveOutcome | null> {
		const contextMessages: Message[] = job.assistant ? [job.assistant, prompt] : [prompt];
		let response: AssistantMessage;
		try {
			response = await complete(model, { messages: contextMessages }, { apiKey, headers, signal, onPayload });
		} catch (error) {
			if (!signal.aborted) {
				job.ctx.ui.notify(`hydra: observer call failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return null;
		}
		return { response, usages: [flattenUsage(response.usage)], iterations: 1, toolsUsed: [] };
	}

	// Acting heads run pi's own agent loop rather than a hand-rolled
	// imitation: argument validation, unknown-tool error results, parallel vs
	// sequential execution policy, and abort discipline stay pi's code and
	// evolve with it. Every provider call the loop makes flows through the
	// same byte-true merge as a verdict observation (onPayload discards the
	// loop's own built context), so the driver prefix stays a pure cache
	// read and the loop turns are cached once by the marker the merge
	// advances; see mergeObserverPayload for the cache story.
	async function observeWithTools(
		job: Observation,
		model: Model<"anthropic-messages">,
		apiKey: string,
		headers: Record<string, string> | undefined,
		prompt: Message,
		onPayload: (built: unknown) => unknown,
		signal: AbortSignal,
	): Promise<ObserveOutcome | null> {
		const usages: ObserverUsage[] = [];
		const toolsUsed: string[] = [];
		let iterations = 0;
		let messages: Awaited<ReturnType<typeof runAgentLoop>>;
		try {
			messages = await runAgentLoop(
				[prompt],
				{ systemPrompt: "", messages: job.assistant ? [job.assistant] : [], tools: observerTools(job.ctx) },
				{
					model,
					apiKey,
					headers,
					onPayload,
					// Our tail messages are plain LLM messages already; drop
					// anything else defensively (contract: must not throw).
					convertToLlm: (agentMessages) =>
						agentMessages.filter(
							(message): message is Message =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						),
					// Correctness guard, not a cost ceiling: wind down a loop
					// that does not converge on a verdict, and wind down early
					// when hydra is disabled mid-loop.
					shouldStopAfterTurn: () => !enabled || ++iterations >= MAX_TOOL_ITERATIONS,
					afterToolCall: async (event) => {
						toolsUsed.push(event.toolCall.name);
						if (!event.isError) {
							announceWrite(job, event.toolCall);
						}
						return undefined;
					},
				},
				async (event) => {
					if (event.type === "message_end" && event.message.role === "assistant") {
						usages.push(flattenUsage((event.message as AssistantMessage).usage));
					}
				},
				signal,
			);
		} catch (error) {
			if (!signal.aborted) {
				job.ctx.ui.notify(`hydra: observer loop failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return null;
		}

		const response = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
		if (!response) {
			job.ctx.ui.notify("hydra: observer loop produced no response", "warning");
			return null;
		}
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			if (!signal.aborted) {
				job.ctx.ui.notify(`hydra: observer loop failed: ${response.errorMessage ?? "aborted"}`, "error");
			}
			return null;
		}
		if (response.stopReason === "toolUse" && enabled) {
			job.ctx.ui.notify(`hydra: ${job.lens} hit ${MAX_TOOL_ITERATIONS} turns without a verdict; wound down`, "warning");
		}
		return { response, usages, iterations, toolsUsed };
	}

	// The observer executes through pi's own tool implementations at the
	// driver's cwd. write/edit serialize same-file mutations through pi's
	// process-wide per-file queue, shared with the driver because the
	// extension loader aliases @earendil-works/pi-coding-agent to its bundled
	// instance (one module, one queue). The replayed payload's tools array is
	// what the model can call: parity with the driver comes from the replay
	// itself, and a call to anything outside this registry (another
	// extension's tool, MCP) gets pi's standard "tool not found" error result
	// and the head moves on to its verdict.
	let standardObserverTools: AgentTool[] | null = null;
	function observerTools(ctx: ExtensionContext): AgentTool[] {
		if (!standardObserverTools) {
			standardObserverTools = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
				createGrepTool(ctx.cwd),
				createFindTool(ctx.cwd),
				createLsTool(ctx.cwd),
			];
		}
		// Plus hydra's own tool: an acting head may retune its peers through
		// the same tool the driver uses.
		return [
			...standardObserverTools,
			{
				name: hydraToolDefinition.name,
				label: hydraToolDefinition.label,
				description: hydraToolDefinition.description,
				parameters: hydraToolDefinition.parameters,
				execute: (toolCallId, params, toolSignal, _onUpdate) =>
					hydraToolDefinition.execute(toolCallId, params as HydraToolParams, toolSignal, undefined, ctx),
			},
		];
	}

	// Every observer file write also queues a one-line note, so the driver is
	// never surprised by files changing under it. Provenance rather than a
	// finding: it bypasses the delivery-mode cap on purpose (a print-mode
	// session still learns its files moved). Writes that happen inside the
	// observer's bash commands are invisible here; documented limitation.
	function announceWrite(job: Observation, toolCall: ToolCall) {
		if (toolCall.name !== "write" && toolCall.name !== "edit") {
			return;
		}
		const path = typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "a file";
		const details: FeedbackDetails = { lens: job.lens, action: "queue", reason: "observer file write", deliveryMode };
		pi.sendMessage(
			{
				customType: "hydra-feedback",
				content: `[${job.lens}] ${toolCall.name === "write" ? "wrote" : "edited"} ${path}`,
				display: true,
				details,
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	function routeDecision(ctx: ExtensionContext, decision: Decision, decisionLens: string, staleSnapshot: boolean) {
		if (decision.action === "noop" || !decision.message) {
			return;
		}

		// The observer reviews overlapping snapshots, so identical findings
		// recur; deliver each one once per lens. Diagnostic lenses are exempt:
		// their message is fixed by design, and every smoke-test firing must be
		// visible.
		if (!(decisionLens in DIAGNOSTIC_PROMPTS)) {
			const key = `${decisionLens}|${decision.action}|${decision.message}`;
			if (delivered.has(key)) {
				return;
			}
			delivered.add(key);
			if (delivered.size > MAX_DELIVERED_KEYS) {
				delivered.delete(delivered.values().next().value as string);
			}
		}

		const formatted = `[${decisionLens}] ${decision.message}`;
		const details: FeedbackDetails = { lens: decisionLens, action: decision.action, reason: decision.reason, deliveryMode };
		const force = effectiveForce(decision.action, deliveryMode, staleSnapshot);

		if (force >= 2) {
			// steer: a real user message between turns of the current run.
			// interrupt: pull the cord; abort the in-flight run and deliver the
			// finding as a follow-up, which opens the next run. When the agent
			// is idle there is nothing to steer or abort, so just send.
			try {
				if (ctx.isIdle()) {
					pi.sendUserMessage(formatted);
				} else if (force === 3) {
					ctx.abort();
					pi.sendUserMessage(formatted, { deliverAs: "followUp" });
				} else {
					pi.sendUserMessage(formatted, { deliverAs: "steer" });
				}
			} catch (error) {
				ctx.ui.notify(
					`hydra: ${force === 3 ? "interrupt" : "steer"} failed: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			return;
		}

		pi.sendMessage(
			{ customType: "hydra-feedback", content: formatted, display: true, details },
			force === 1 ? { deliverAs: "followUp", triggerTurn: false } : { triggerTurn: false },
		);
	}

	// Run one head's observations to completion, newest snapshot first
	// (conflating whatever piled up while busy). Heads run in parallel with
	// each other: mid-run they are all pure cache reads; at run-end each fork
	// pays M's write (the measured economics are in docs/architecture.md).
	async function runHead(head: Head): Promise<void> {
		try {
			while (head.pending) {
				if (!enabled) {
					head.pending = null;
					break;
				}
				const job = head.pending;
				head.pending = null;
				try {
					await observe(job, lifecycleAbort.signal);
				} catch (error) {
					if (!lifecycleAbort.signal.aborted) {
						job.ctx.ui.notify(`hydra: observe error: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			}
		} finally {
			head.running = null;
		}
	}

	// One observation per active lens, all from the same captured snapshot.
	// An empty set observes nothing (reached by removing heads one by one).
	function scheduleObservations(ctx: ExtensionContext, kind: ObserveKind, assistant: AssistantMessage | null) {
		for (const name of lenses) {
			const tools = lensUsesTools(name);
			let head = heads.get(name);
			if (!head) {
				head = { pending: null, running: null };
				heads.set(name, head);
			}
			head.pending = {
				ctx,
				payload: capturedPayload,
				assistant,
				turnIndex: currentTurnIndex,
				lens: name,
				prompt: observerPromptFor(name, tools),
				tools,
				kind,
			};
			if (!head.running) {
				head.running = runHead(head);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		discoverLenses(ctx);
		if (!restoreFromBranch(ctx)) {
			applyFlags(ctx);
			updateFooter(ctx);
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		// Branch navigation changes which hydra entries are in scope.
		restoreFromBranch(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		awaitingFirstResponseOfRun = true;
		capturedThisRun = false;
		// Pick up lens edits made since the last run (the in-session tuning loop).
		discoverLenses(ctx);
	});

	pi.on("turn_start", (event) => {
		currentTurnIndex = event.turnIndex;
	});

	pi.on("before_provider_request", (event) => {
		if (!enabled) {
			return;
		}
		// Capture the driver's exact bytes; never modify them.
		capturedPayload = structuredClone(event.payload);
		responseTimestamp = null;
		capturedThisRun = true;
	});

	// Piggyback trigger: a driver response began streaming, which is the
	// moment Anthropic commits the request's cache entry (commit-at-TTFT,
	// verified in the experiments). Observing the captured payload now is a
	// pure cache read, and the verdict lands while the response is still
	// streaming. The run's first request is skipped; the previous run-end
	// observation has already reviewed everything before it.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}
		// The first assistant message after a capture is that request's own
		// response; remember its timestamp so the run-end trigger can match M
		// by identity. Recorded ahead of the enabled gate: it is bookkeeping,
		// and /hydra can be toggled mid-stream.
		if (capturedPayload && responseTimestamp === null) {
			responseTimestamp = (event.message as AssistantMessage).timestamp ?? null;
		}
		if (!enabled || !capturedPayload) {
			return;
		}
		if (awaitingFirstResponseOfRun) {
			awaitingFirstResponseOfRun = false;
			return;
		}
		scheduleObservations(ctx, "piggyback", null);
	});

	// Run-end trigger: the agent handed control back to the user, so nothing
	// will carry the final assistant message M into the cache until the next
	// prompt. Fork with M attached (serialized by pi-ai itself in observe).
	// Runs that produced no usable M (command-only input, immediate aborts,
	// error turns) have nothing new to review and schedule nothing.
	pi.on("agent_end", (event, ctx) => {
		if (!enabled || !capturedPayload || !capturedThisRun) {
			return;
		}
		// selectFinalAssistant guarantees role "assistant" with block content.
		const assistant = selectFinalAssistant(event.messages, responseTimestamp) as AssistantMessage | null;
		if (!assistant) {
			return;
		}
		scheduleObservations(ctx, "run-end", assistant);
	});

	pi.on("session_shutdown", async () => {
		// Let the in-flight observations finish (bounded), then cancel; this
		// is the sole lifecycle abort.
		const running = [...heads.values()].flatMap((head) => head.running ?? []);
		if (running.length > 0) {
			const timeout = new Promise<void>((resolve) =>
				setTimeout(resolve, parseShutdownGrace(process.env.HYDRA_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_GRACE_MS)),
			);
			await Promise.race([Promise.all(running), timeout]);
		}
		lifecycleAbort.abort();
	});

	pi.registerMessageRenderer<FeedbackDetails>("hydra-feedback", (message, { expanded }, theme) => {
		const details = message.details;
		const action = details?.action ?? "noop";
		const actionColor =
			action === "interrupt" ? "error" : action === "steer" ? "accent" : action === "queue" ? "warning" : "muted";

		let text =
			theme.fg("accent", "🐍 hydra ") +
			theme.fg("toolTitle", `[${details?.lens ?? "?"}]`) +
			" " +
			theme.fg(actionColor, `(${action})`) +
			"\n" +
			theme.fg("toolOutput", typeof message.content === "string" ? message.content : "");
		if (expanded && details) {
			text += `\n${theme.fg("dim", `reason: ${details.reason || "—"} · delivery: ${details.deliveryMode}`)}`;
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// The agent's hand on the tool-changer: full self-configuration of its own
	// observer. Lens writes are user-scoped markdown files, every change is
	// announced and visible in the footer, and the observers themselves see
	// the reconfiguration in the replayed context. The definition is named so
	// acting heads can execute it too (observerTools).
	const hydraToolParameters = Type.Object({
		action: StringEnum(["list", "set-lenses", "write-lens", "remove-lens"] as const, {
			description: "What to do",
		}),
		lenses: Type.Optional(Type.Array(Type.String(), { description: "set-lenses: the lens set to observe with" })),
		name: Type.Optional(Type.String({ description: "write-lens/remove-lens: lens name (kebab-case)" })),
		instruction: Type.Optional(
			Type.String({ description: "write-lens: the lens instruction (one focus, explicit do-NOT boundaries, short)" }),
		),
		description: Type.Optional(Type.String({ description: "write-lens: one-line description" })),
		tools: Type.Optional(
			Type.Boolean({ description: "write-lens: acting head that may use tools before its verdict (default false)" }),
		),
		activate: Type.Optional(Type.Boolean({ description: "write-lens: also add to the active set (default true)" })),
	});
	type HydraToolParams = Static<typeof hydraToolParameters>;
	const hydraToolDefinition = {
		name: "hydra",
		label: "Hydra",
		description: [
			"Configure your hydra observer heads. Each lens is an independent reviewer",
			"watching your full context. Use set-lenses when the work changes phase",
			"(e.g. design wants devil's-advocate thinking, execution wants quality and",
			"security, review wants simplifier), write-lens to create or tune a head for",
			"the task at hand (it persists as a markdown file and applies immediately),",
			"and remove-lens to retire one. list shows the current setup. A lens written",
			"with tools=true becomes an acting head: it may read files, run commands, and",
			"write files before its verdict (e.g. a docs head that keeps notes current,",
			"usually ending noop because its work product is the files).",
		].join(" "),
		parameters: hydraToolParameters,
		async execute(
			_toolCallId: string,
			params: HydraToolParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const reply = (text: string) => ({
				content: [{ type: "text" as const, text }],
				details: { lenses, deliveryMode, enabled },
			});
			switch (params.action) {
				case "list": {
					const custom = [...customLenses.values()]
						.map(
							(definition) =>
								`  ${definition.name}${definition.tools ? " [acting]" : ""}${definition.description ? `: ${definition.description}` : ""}`,
						)
						.join("\n");
					return reply(
						[
							`active: ${lenses.join(", ")} | delivery: ${deliveryMode} | ${enabled ? "enabled" : "disabled"}`,
							`built-in: ${BUILT_IN_LENS_NAMES.join(", ")}`,
							custom ? `custom (${lensDir}):\n${custom}` : `custom: none (${lensDir})`,
						].join("\n"),
					);
				}
				case "set-lenses": {
					if (!params.lenses || params.lenses.length === 0) {
						return reply("set-lenses needs `lenses`.");
					}
					return setLensSet(ctx, params.lenses)
						? reply(`observing with: ${lenses.join(", ")}`)
						: reply(`no valid lenses in ${params.lenses.join(", ")}; still observing with ${lenses.join(", ")}`);
				}
				case "write-lens": {
					const name = params.name?.trim() ?? "";
					const instruction = params.instruction?.trim() ?? "";
					if (!isValidLensName(name)) {
						return reply("write-lens needs a kebab-case `name`.");
					}
					if (name in DIAGNOSTIC_PROMPTS) {
						return reply(`"${name}" is a reserved diagnostic lens.`);
					}
					if (instruction.length === 0) {
						return reply("write-lens needs an `instruction`.");
					}
					const fileBody = buildLensFile({
						name,
						description: params.description,
						tools: params.tools === true || undefined,
						prompt: instruction,
					});
					mkdirSync(lensDir, { recursive: true });
					writeFileSync(join(lensDir, `${name}.md`), fileBody);
					// Store the parse of what was written, so memory and disk agree
					// by construction (parseLensFile is buildLensFile's inverse).
					const definition = parseLensFile(name, fileBody);
					if (definition) {
						customLenses.set(name, definition);
					}
					if (params.activate !== false) {
						setLensSet(ctx, [...lenses.filter((active) => !(active in DIAGNOSTIC_PROMPTS)), name]);
					}
					ctx.ui.notify(`hydra: agent wrote lens "${name}"${params.activate !== false ? " and activated it" : ""}`, "info");
					return reply(`lens "${name}" written to ${join(lensDir, `${name}.md`)}; active set: ${lenses.join(", ")}`);
				}
				case "remove-lens": {
					const name = params.name?.trim() ?? "";
					if (!customLenses.has(name)) {
						return reply(
							name in LENS_PROMPTS
								? `"${name}" is built-in; you can override it with write-lens, but not remove it.`
								: `no custom lens named "${name}".`,
						);
					}
					rmSync(join(lensDir, `${name}.md`));
					customLenses.delete(name);
					const remaining = lenses.filter((active) => active !== name);
					if (remaining.length > 0) {
						setLensSet(ctx, remaining);
					} else {
						// Removing the last head is the deliberate, head-by-head path
						// to silence; there is no bulk off switch on this tool.
						lenses = [];
						productLenses = [];
						persistConfig();
						updateFooter(ctx);
					}
					ctx.ui.notify(`hydra: agent removed lens "${name}"`, "info");
					return reply(
						`lens "${name}" removed${name in LENS_PROMPTS ? " (built-in restored)" : ""}; active set: ${
							lenses.length > 0 ? lenses.join(", ") : "empty (hydra observes nothing until a lens is set)"
						}`,
					);
				}
			}
		},
	};
	pi.registerTool(hydraToolDefinition);

	pi.registerCommand("hydra", {
		description: "Toggle hydra observer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			persistConfig();
			updateFooter(ctx);
			ctx.ui.notify(`hydra: ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("hydra-lens", {
		description: `Set the hydra lens set (comma-separated): ${BUILT_IN_LENS_NAMES.join(" | ")} or custom lenses from ~/.pi/agent/hydra/lenses`,
		getArgumentCompletions: (prefix: string) => {
			// Complete the segment after the last separator, so lens sets can be
			// typed as "quality,sec<tab>".
			const split = prefix.match(/^(.*[,\s])?([^,\s]*)$/);
			const base = split?.[1] ?? "";
			const partial = split?.[2] ?? "";
			return lensNames()
				.filter((name) => name.startsWith(partial))
				.map((name) => ({ value: base + name, label: customLenses.has(name) ? `${name} (custom)` : name }));
		},
		handler: async (args, ctx) => {
			const requested = parseLensList(args);
			if (requested.length === 0) {
				ctx.ui.notify(`hydra: usage: /hydra-lens <name>[,<name>...]. valid: ${lensNames().join(", ")}`, "warning");
				return;
			}
			if (setLensSet(ctx, requested)) {
				ctx.ui.notify(`hydra: lenses=${lenses.join("+")}`, "info");
			}
		},
	});

	pi.registerCommand("hydra-delivery", {
		description: "Set hydra delivery mode: print | queue | steer | interrupt",
		getArgumentCompletions: (prefix: string) =>
			DELIVERY_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode })),
		handler: async (args, ctx) => {
			const requested = args.trim() as DeliveryMode;
			if (!DELIVERY_MODES.includes(requested)) {
				ctx.ui.notify("hydra: unknown mode. valid: print | queue | steer | interrupt", "warning");
				return;
			}
			deliveryMode = requested;
			persistConfig();
			updateFooter(ctx);
			ctx.ui.notify(`hydra: delivery=${deliveryMode}`, "info");
		},
	});

	pi.registerCommand("hydra-stats", {
		description: "Show hydra observer statistics",
		handler: async (_args, ctx) => {
			if (calls.length === 0) {
				ctx.ui.notify("hydra: no observations yet", "info");
				return;
			}
			const { cost, read, write, input, meanHit } = cumulative();
			const counts = { noop: 0, queue: 0, steer: 0, interrupt: 0 };
			let totalDuration = 0;
			for (const call of calls) {
				counts[call.action]++;
				totalDuration += call.durationMs;
			}
			const recent = calls
				.slice(-10)
				.map(
					(call) =>
						`  turn ${call.turnIndex} ${call.lens}${call.kind ? ` [${call.kind}]` : ""} ${call.action}${
							call.iterations ? ` (${call.iterations} turns: ${[...new Set(call.toolsUsed ?? [])].join(",") || "no tools"})` : ""
						}  hit=${call.hitRatio.toFixed(1)}%  $${call.cost.toFixed(4)}  ${call.durationMs}ms`,
				)
				.join("\n");
			ctx.ui.notify(
				[
					`hydra stats (${calls.length} observations):`,
					`  mean hit: ${meanHit.toFixed(2)}%   ← target: 97%+`,
					`  total cost: $${cost.toFixed(4)}`,
					`  total cache read: ${read.toLocaleString()} tokens`,
					`  total cache write: ${write.toLocaleString()} tokens`,
					`  total input (uncached): ${input.toLocaleString()} tokens`,
					`  mean duration: ${(totalDuration / calls.length).toFixed(0)}ms`,
					`  decisions: ${counts.noop} noop / ${counts.queue} queue / ${counts.steer} steer / ${counts.interrupt} interrupt`,
					"",
					`recent (last ${Math.min(10, calls.length)}):`,
					recent,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("hydra-debug", {
		description: "Toggle hydra payload dumping for cache debugging",
		handler: async (_args, ctx) => {
			if (debugDir) {
				debugDir = null;
				ctx.ui.notify("hydra: debug dumping disabled", "info");
				return;
			}
			const dir = join(tmpdir(), `hydra-debug-${Date.now()}`);
			try {
				mkdirSync(dir, { recursive: true });
			} catch (error) {
				ctx.ui.notify(`hydra: failed to create debug dir: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
			debugDir = dir;
			ctx.ui.notify(`hydra: dumping payloads to ${dir}`, "info");
		},
	});
}
