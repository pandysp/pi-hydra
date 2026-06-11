/**
 * hydra: commit-point observer for pi.
 *
 * Watches the driver's conversation through a side model that replays the
 * driver's exact provider payload with one observer prompt appended. Because
 * the prefix is byte-identical, every observation is a prompt-cache read of
 * the entry the driver itself just wrote (97%+ hit ratio). The observer
 * answers with a JSON decision (noop, queue, or interrupt) which hydra
 * routes back into the session.
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
 *   /hydra-lens       pick the review lens (quality, security, ...)
 *   /hydra-delivery   pick how findings reach you (print, queue, interrupt)
 *   /hydra-stats      cache hit ratio, cost, and recent decisions
 *   /hydra-debug      dump driver/observer payload pairs for diffing
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import type { Action, AnthropicPayload, Decision } from "./utils";
import { isAnthropicPayload, mergeObserverPayload, parseDecision } from "./utils";

// How long session_shutdown waits for an in-flight observation before
// aborting it. Headless runs (`pi -p`) exit right after agent_end, so slow
// models need a longer grace there; 0 means exit without waiting.
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

function shutdownGraceMs(): number {
	const raw = process.env.HYDRA_SHUTDOWN_GRACE_MS;
	const parsed = raw == null || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SHUTDOWN_GRACE_MS;
}

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

{"action":"interrupt","reason":"test interrupt","message":"hydra interrupt fired; if you see this in your context, between-turns steering works"}

No preamble, no thinking, no explanation. Just the JSON, byte-for-byte.</system-reminder>`,
} as const;

type ProductLens = keyof typeof LENS_PROMPTS;
type LensName = ProductLens | keyof typeof DIAGNOSTIC_PROMPTS;
type DeliveryMode = "print" | "queue" | "interrupt";
type ObserveKind = "piggyback" | "run-end";

const LENS_NAMES = Object.keys(LENS_PROMPTS) as LensName[];
const DELIVERY_MODES: DeliveryMode[] = ["print", "queue", "interrupt"];

function isLensName(value: string): value is LensName {
	return value in LENS_PROMPTS || value in DIAGNOSTIC_PROMPTS;
}

// Keep the real-lens prompt SHORT: the driver's context is already cached, so
// this prompt is the only fresh input the observer pays for per call.
function buildObserverPrompt(lens: LensName): string {
	if (lens in DIAGNOSTIC_PROMPTS) {
		return DIAGNOSTIC_PROMPTS[lens as keyof typeof DIAGNOSTIC_PROMPTS];
	}
	return `<system-reminder>Side observer. Reply with one JSON object, nothing else:
{"action":"noop|queue|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}

LENS: ${LENS_PROMPTS[lens as keyof typeof LENS_PROMPTS]}

Noop unless something warrants feedback. Queue if useful but waitable. Interrupt only for urgent issues. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${lens}].</system-reminder>`;
}

// One observer call, persisted to the session as a custom "hydra-call" entry
// so /hydra-stats survives resume and branch navigation.
interface AndonCall {
	timestamp: number;
	turnIndex: number;
	lens: LensName;
	kind?: ObserveKind;
	action: Action;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	hitRatio: number;
	rawResponse?: string;
}

interface Observation {
	ctx: ExtensionContext;
	payload: unknown;
	assistant: AssistantMessage | null;
	turnIndex: number;
	lens: LensName;
	kind: ObserveKind;
}

interface FeedbackDetails {
	lens: LensName;
	action: Action;
	reason: string;
	deliveryMode: DeliveryMode;
}

const MAX_DELIVERED_KEYS = 200;

export default function (pi: ExtensionAPI) {
	let enabled = true;
	let lens: LensName = "quality";
	let productLens: ProductLens = "quality";
	let deliveryMode: DeliveryMode = "print";

	// Driver capture: the exact provider payload of the most recent request,
	// plus enough run state to know what it represents.
	let capturedPayload: unknown = null;
	let capturedThisRun = false;
	let awaitingFirstResponseOfRun = true;
	let currentTurnIndex = 0;

	// Conflating single-slot scheduler: at most one observation in flight, and
	// a newer snapshot overwrites the waiting slot. Observations always run to
	// completion; staleness is bounded to one cycle because the slot always
	// holds the newest snapshot. drainPromise is non-null iff the pump runs;
	// session_shutdown awaits it.
	let pending: Observation | null = null;
	let drainPromise: Promise<void> | null = null;
	const lifecycleAbort = new AbortController();

	// Stats, rebuilt from the current session branch on restore.
	let calls: AndonCall[] = [];
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
		if (calls.length === 0) {
			ctx.ui.setStatus("hydra", ctx.ui.theme.fg("muted", `hydra: ${lens} | ${deliveryMode} | (no obs yet)`));
			return;
		}
		const { cost, meanHit } = cumulative();
		const lastHit = calls[calls.length - 1].hitRatio;
		const hitColor = meanHit >= 97 ? "success" : meanHit >= 90 ? "warning" : "error";
		ctx.ui.setStatus(
			"hydra",
			ctx.ui.theme.fg("toolTitle", `hydra:${lens}`) +
				" " +
				ctx.ui.theme.fg("muted", deliveryMode) +
				" " +
				ctx.ui.theme.fg(hitColor, `hit ${meanHit.toFixed(1)}% (last ${lastHit.toFixed(1)}%)`) +
				" " +
				ctx.ui.theme.fg("dim", `$${cost.toFixed(4)} (${calls.length} obs)`),
		);
	}

	function restoreStats(ctx: ExtensionContext) {
		calls = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "hydra-call") {
				const data = entry.data as AndonCall | undefined;
				if (data && typeof data === "object") {
					calls.push(data);
				}
			}
		}
		updateFooter(ctx);
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
			content: [{ type: "text", text: buildObserverPrompt(job.lens) }],
			timestamp: Date.now(),
		};
		const contextMessages: Message[] = job.assistant ? [job.assistant, prompt] : [prompt];

		const t0 = Date.now();
		let response: AssistantMessage;
		try {
			response = await complete(
				model,
				{ messages: contextMessages },
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					onPayload: (built) => {
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
					},
				},
			);
		} catch (error) {
			if (!signal.aborted) {
				job.ctx.ui.notify(`hydra: observer call failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return;
		}
		if (signal.aborted) {
			return;
		}

		const usage: Usage = response.usage;
		const readable = usage.input + usage.cacheRead + usage.cacheWrite;
		// A zero-usage, zero-content response is a provider hiccup (e.g. an
		// overload surfaced as an empty result), not an observation.
		if (readable === 0 && response.content.length === 0) {
			job.ctx.ui.notify("hydra: observer call returned empty response (provider overloaded?)", "warning");
			return;
		}

		const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const decision = parseDecision(text);

		const call: AndonCall = {
			timestamp: Date.now(),
			turnIndex: job.turnIndex,
			lens: job.lens,
			kind: job.kind,
			action: decision.action,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost.total,
			durationMs: Date.now() - t0,
			hitRatio: readable > 0 ? (usage.cacheRead / readable) * 100 : 0,
			rawResponse: text.length > 200 ? `${text.slice(0, 200)}…` : text,
		};
		calls.push(call);
		pi.appendEntry<AndonCall>("hydra-call", call);

		// Diagnostic lenses are one-shot: revert before routing, otherwise an
		// interrupt delivery re-triggers itself forever (each injected message
		// starts a run whose run-end observation would interrupt again).
		if (job.lens in DIAGNOSTIC_PROMPTS && lens === job.lens) {
			lens = productLens;
			job.ctx.ui.notify(`hydra: diagnostic lens "${job.lens}" fired once; reverting to ${productLens}`, "info");
		}
		updateFooter(job.ctx);

		routeDecision(job.ctx, decision, job.lens);
	}

	function routeDecision(ctx: ExtensionContext, decision: Decision, decisionLens: LensName) {
		if (decision.action === "noop" || !decision.message) {
			return;
		}

		// The observer reviews overlapping snapshots, so identical findings
		// recur; deliver each one once. Diagnostic lenses are exempt: their
		// message is fixed by design, and every smoke-test firing must be
		// visible.
		if (!(decisionLens in DIAGNOSTIC_PROMPTS)) {
			const key = `${decision.action}|${decision.message}`;
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

		if (decision.action === "interrupt" && deliveryMode === "interrupt") {
			// Steer: delivered as a real user message between turns of the
			// current run, or immediately if the agent is idle.
			try {
				pi.sendUserMessage(formatted, ctx.isIdle() ? undefined : { deliverAs: "steer" });
			} catch (error) {
				ctx.ui.notify(`hydra: steer failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			return;
		}

		pi.sendMessage(
			{ customType: "hydra-feedback", content: formatted, display: true, details },
			deliveryMode === "print" ? { triggerTurn: false } : { deliverAs: "followUp", triggerTurn: false },
		);
	}

	// Run one observation at a time to completion, then pick up the newest
	// pending snapshot (conflating whatever piled up while busy).
	async function drain(): Promise<void> {
		try {
			while (pending) {
				if (!enabled) {
					pending = null;
					break;
				}
				const job = pending;
				pending = null;
				try {
					await observe(job, lifecycleAbort.signal);
				} catch (error) {
					if (!lifecycleAbort.signal.aborted) {
						job.ctx.ui.notify(`hydra: observe error: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
				}
			}
		} finally {
			drainPromise = null;
		}
	}

	function schedule(job: Observation) {
		pending = job;
		if (!drainPromise) {
			drainPromise = drain();
		}
	}

	pi.on("session_start", (_event, ctx) => {
		restoreStats(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		// Branch navigation changes which hydra-call entries are in scope.
		restoreStats(ctx);
	});

	pi.on("agent_start", () => {
		awaitingFirstResponseOfRun = true;
		capturedThisRun = false;
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
		capturedThisRun = true;
	});

	// Piggyback trigger: a driver response began streaming, which is the
	// moment Anthropic commits the request's cache entry (commit-at-TTFT,
	// verified in the experiments). Observing the captured payload now is a
	// pure cache read, and the verdict lands while the response is still
	// streaming. The run's first request is skipped; the previous run-end
	// observation has already reviewed everything before it.
	pi.on("message_start", (event, ctx) => {
		if (!enabled || !capturedPayload || event.message.role !== "assistant") {
			return;
		}
		if (awaitingFirstResponseOfRun) {
			awaitingFirstResponseOfRun = false;
			return;
		}
		schedule({ ctx, payload: capturedPayload, assistant: null, turnIndex: currentTurnIndex, lens, kind: "piggyback" });
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
		const assistant = [...event.messages]
			.reverse()
			.find(
				(message): message is AssistantMessage =>
					message.role === "assistant" &&
					message.stopReason !== "error" &&
					message.stopReason !== "aborted" &&
					!message.errorMessage &&
					message.content.length > 0,
			);
		if (!assistant) {
			return;
		}
		schedule({ ctx, payload: capturedPayload, assistant, turnIndex: currentTurnIndex, lens, kind: "run-end" });
	});

	pi.on("session_shutdown", async () => {
		// Let the in-flight observation finish (bounded), then cancel; this is
		// the sole lifecycle abort.
		if (drainPromise) {
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, shutdownGraceMs()));
			await Promise.race([drainPromise, timeout]);
		}
		lifecycleAbort.abort();
	});

	pi.registerMessageRenderer<FeedbackDetails>("hydra-feedback", (message, { expanded }, theme) => {
		const details = message.details;
		const action = details?.action ?? "noop";
		const actionColor = action === "interrupt" ? "error" : action === "queue" ? "warning" : "muted";

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

	pi.registerCommand("hydra", {
		description: "Toggle hydra observer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			updateFooter(ctx);
			ctx.ui.notify(`hydra: ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("hydra-lens", {
		description: `Set hydra lens: ${LENS_NAMES.join(" | ")}`,
		getArgumentCompletions: (prefix: string) =>
			LENS_NAMES.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (!isLensName(requested)) {
				ctx.ui.notify(`hydra: unknown lens. valid: ${LENS_NAMES.join(", ")}`, "warning");
				return;
			}
			lens = requested;
			if (!(requested in DIAGNOSTIC_PROMPTS)) {
				productLens = requested as ProductLens;
			}
			updateFooter(ctx);
			ctx.ui.notify(`hydra: lens=${lens}`, "info");
		},
	});

	pi.registerCommand("hydra-delivery", {
		description: "Set hydra delivery mode: print | queue | interrupt",
		getArgumentCompletions: (prefix: string) =>
			DELIVERY_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode })),
		handler: async (args, ctx) => {
			const requested = args.trim() as DeliveryMode;
			if (!DELIVERY_MODES.includes(requested)) {
				ctx.ui.notify("hydra: unknown mode. valid: print | queue | interrupt", "warning");
				return;
			}
			deliveryMode = requested;
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
			const counts = { noop: 0, queue: 0, interrupt: 0 };
			let totalDuration = 0;
			for (const call of calls) {
				counts[call.action]++;
				totalDuration += call.durationMs;
			}
			const recent = calls
				.slice(-10)
				.map(
					(call) =>
						`  turn ${call.turnIndex} ${call.lens}${call.kind ? ` [${call.kind}]` : ""} ${call.action}  hit=${call.hitRatio.toFixed(1)}%  $${call.cost.toFixed(4)}  ${call.durationMs}ms`,
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
					`  decisions: ${counts.noop} noop / ${counts.queue} queue / ${counts.interrupt} interrupt`,
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
