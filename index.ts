/**
 * hydra: commit-point oversight for pi.
 *
 * Watches the driver's conversation through a side model that replays the
 * driver's exact provider payload with an observation handoff appended. Because
 * the prefix is byte-identical, every observation is a prompt-cache read of
 * entries the driver itself wrote (97%+ hit ratio on Anthropic; on OpenAI
 * Codex the backend's commit latency bounds it lower, see
 * docs/architecture.md). The head
 * returns a validated delivery decision (typed `hydra` completion on OpenAI,
 * compact JSON on Anthropic) naming where its finding lands: nowhere, the
 * TUI, the agent's next turn, its current run, or an emergency abort.
 *
 * A head is one markdown file: frontmatter for identity and capabilities,
 * body for the instruction. Files live in ~/.pi/agent/hydra (user) and
 * .pi/hydra (project; a project head shadows a same-named user head). By
 * default a head may run the driver's own tools through pi's agent loop
 * before deciding; `tools: []` makes a judge-only head, a list narrows the
 * executable set. Every loop call replays the same byte-true prefix; every
 * file write is announced to the session.
 *
 * Observations fire at the driver's own cache commit points (see
 * experiments/README.md for the empirical basis):
 *
 * - Piggyback (mid-run): when a driver response begins streaming, the request
 *   that produced it has just been committed to the cache. Replaying that
 *   request is a pure cache read, fresh through the latest tool results.
 * - Run-end (agent_end): no further driver request will carry the final
 *   assistant message M into the cache, so the observation appends M itself,
 *   serialized by pi-ai's own provider code via the onPayload hook. On
 *   Anthropic, the driver's message-level cache marker moves onto M, so the
 *   fork's write also pre-warms the driver's next, human-paced turn. On
 *   OpenAI (GPT-5.6+, implicit breakpoints), no marker exists to move: the
 *   fork reads the warm prefix and pays the newest turn plus its own tail.
 *
 * Usage:
 *   pi install git:github.com/pandysp/pi-hydra
 *   /hydra-heads      no argument opens the picker; an argument sets the
 *                     active heads ("quality,security"), `none` clears them
 *   /hydra-stats      cache hit ratio, cost, and recent decisions
 *   /hydra-debug      dump driver/observation payload pairs for diffing
 *
 * The agent manages head files like any other file and points the heads
 * through the registered `hydra` tool's `manage_heads` action. The active set
 * is session state; everything else about a head lives in its file.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop, uuidv7 } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Message, Model, ProviderHeaders, ToolCall } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	Action,
	AfterChangeAction,
	Decision,
	HydraConfig,
	ObservationLoopStopReason,
	ObservationUsage,
} from "./utils";
import { consumeDeliveredMessage, DeliveryLedger, routeFeedback } from "./delivery";
import type { DeliveryGateway } from "./delivery";
import { DIAGNOSTIC_PROMPTS, HeadRegistry } from "./heads";
import type { HeadRegistryGateway } from "./heads";
import type { PersistedDelivery } from "./utils";
import {
	hydraToolDescription,
	hydraToolParameters,
	isTerminalHydraAction,
	validateHydraToolParams,
} from "./protocol";
import type { ManageHeadsParams, RawHydraToolParams } from "./protocol";
import { HeadScheduler } from "./scheduler";
import { hitBandsFor, parseBranchEntries, StatsLog } from "./stats";
import type { HydraCall, ObserveKind } from "./stats";
import {
	advanceObservationLoopGuard,
	applyAfterChangeDelivery,
	buildEnumeratedJudgeObservationEnvelope,
	buildEnumeratedJudgeObservationPrompt,
	buildObservationEnvelope,
	buildAnthropicObservationPrompt,
	buildObservationPrompt,
	classifyCodexShareLoss,
	decisionFromCompletion,
	decisionFromLoopStopReason,
	formatHeadManagementReceipt,
	hasDriverContinuationError,
	headActs,
	isAnthropicPayload,
	isOpenAIResponsesPayload,
	mergeObservationPayload,
	mergeOpenAIObservationPayload,
	parseDecision,
	parseEnumeratedDecision,
	parseHeadList,
	parseShutdownGrace,
	selectFinalAssistant,
	summarizeLoopUsage,
	usesSplitObservationHandoff,
} from "./utils";

/**
 * An extension can wrap a provider to change how its requests are sent, for
 * example to bill them to a subscription instead of an API key. pi applies
 * that wrapper to the driver's turns, but pi-ai's own `streamSimple` knows
 * nothing about it and would send observations straight to the provider. The
 * observation is then billed against a different quota than the turn it is
 * observing, and gets rejected on its own while the driver keeps working.
 *
 * Looked up on every call rather than cached, because an extension can
 * register its wrapper late or replace it mid-session.
 *
 * Checked against pi 0.82 and 0.84.1.
 */
function resolveStreamSimple(ctx: ExtensionContext, model: Model<Api>): typeof streamSimple {
	// pi types this method but documents it nowhere, and does not export its
	// return type, so the shape has to be written out here by hand. Every part
	// is optional on purpose: if a future pi changes it, observations must fall
	// back quietly rather than throw on every single call.
	const registry = ctx.modelRegistry as {
		getRegisteredProviderConfig?: (provider: string) => { api?: string; streamSimple?: unknown } | undefined;
	};
	if (typeof registry.getRegisteredProviderConfig !== "function") return streamSimple;
	const config = registry.getRegisteredProviderConfig(model.provider);
	// The same rule pi applies in composeModelProvider: a wrapper only counts
	// for the API it was registered for, otherwise the request goes through
	// code that never expected it. One deliberate difference from pi: pi wraps
	// this call so the request is built lazily and hydra does not. That has
	// never mattered because the answer is always used immediately, but it is
	// the first thing to check if streaming here ever misbehaves.
	if (typeof config?.streamSimple !== "function" || config.api !== model.api) return streamSimple;
	return config.streamSimple as typeof streamSimple;
}

/**
 * Most setups have no wrapper at all, so its absence is never worth a warning
 * on its own. It only becomes a useful explanation once a request has actually
 * been refused.
 *
 * Takes the transport that was used rather than looking it up a second time,
 * so the explanation always matches the call it describes even when several
 * observations are running at once.
 */
function observationFailureHint(transport: typeof streamSimple, message: string): string {
	if (transport !== streamSimple) return "";
	// Only when the provider refused the request itself. Overloads, network
	// drops and cancellations say nothing about which transport was used.
	const looksLikeRejection = /\b400\b|invalid_request_error|extra usage|unauthorized|authentication/i.test(message);
	return looksLikeRejection
		? " (no provider transport override was resolved; if an extension shapes this provider's requests, hydra's observations are bypassing it)"
		: "";
}

// Headless runs (`pi -p`) quit as soon as the agent stops, which would cut off
// an observation still waiting on a slow model. 0 means quit without waiting.
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

// Not a cost limit. A head that still has not reached a decision after this
// many model turns is not going to, so the loop is wound down with a warning
// rather than left running.
const MAX_TOOL_ITERATIONS = 25;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function plainMessageText(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "text") {
			return null;
		}
		const text = (block as { text?: unknown }).text;
		if (typeof text !== "string") return null;
		parts.push(text);
	}
	return parts.join("");
}

interface ObservationSeed {
	ctx: ExtensionContext;
	payload: unknown;
	assistant: AssistantMessage | null;
	turnIndex: number;
	head: string;
	instruction: string; // frozen at scheduling time; delivery facts are not
	afterChange?: AfterChangeAction;
	tools: string[] | undefined; // executable allowance: undefined = all, [] = judge-only
	kind: ObserveKind;
	branchGeneration: number;
}

interface Observation extends ObservationSeed {
	prompt: string; // lens is frozen at scheduling; delivery facts resolve when execution starts
	// On providers where it measured better, the rules for answering are sent
	// as their own message right after the head's instruction. Undefined means
	// both go in one message instead.
	envelope?: string;
	// How the head is expected to hand back its decision. Judge-only heads use
	// the numbered JSON form that measured best. Heads that can act keep
	// whichever way already works on their provider.
	completionMode?: "tool" | "json" | "enum";
}

interface FeedbackDetails {
	head: string;
	action: Action;
	reason: string;
	// Pre-rename entries persisted `lens`; the renderer falls back to it.
	lens?: string;
}

export default function hydraExtension(pi: ExtensionAPI) {
	pi.registerFlag("hydra-heads", {
		description: "Initial hydra head set, comma-separated, or `none` (beats the saved session set)",
		type: "string",
	});

	const userHeadDir = join(getAgentDir(), "hydra");
	const registry = new HeadRegistry(userHeadDir);

	// Headless mode implements ctx.ui.notify as a no-op, and headless runs
	// are exactly where a silent failure costs the most; warnings and errors
	// fall back to stderr there.
	function notifyUser(ctx: ExtensionContext, message: string, level: "warning" | "error") {
		if (ctx.hasUI) {
			ctx.ui.notify(message, level);
		} else {
			process.stderr.write(`${message}\n`);
		}
	}

	// Discovery and capture run constantly; a standing problem must warn
	// once, not once per run until it is fixed.
	const warned = new Set<string>();
	function warnOnce(ctx: ExtensionContext, message: string) {
		if (warned.has(message)) {
			return;
		}
		warned.add(message);
		notifyUser(ctx, message, "warning");
	}

	function isDirectory(path: string): boolean {
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}

	// The registry's pi effects, rebuilt per call so messages carry the
	// caller's context; mirrors deliveryGateway below.
	function registryGateway(ctx: ExtensionContext): HeadRegistryGateway {
		return {
			readDir: (dir) => readdirSync(dir),
			readFile: (path) => readFileSync(path, "utf8"),
			isDirectory,
			announce: (message) => ctx.ui.notify(message, "info"),
			notify: (message, level) => notifyUser(ctx, message, level),
			warnOnce: (message) => warnOnce(ctx, message),
			persistConfig: (heads) => pi.appendEntry<HydraConfig>("hydra-config", { heads }),
			onActiveSetChanged: () => updateFooter(ctx),
		};
	}

	// Asked of pi rather than read from the settings file here, so which file
	// wins, who is allowed to set it, and the old `websockets: true` spelling
	// all stay pi's problem and keep working as pi changes. Asked fresh every
	// time: the user can switch transport mid-session and pi points the
	// running agent at the new one straight away, so a remembered answer
	// would be wrong in the direction that costs money. Once a session gives
	// up cache sharing it never takes it back, which covers both ways the
	// setting can change apart from one unavoidable race, described at
	// codexShareLostReason.
	let lastReadTransport: string | null = null;
	function driverTransport(ctx: ExtensionContext): string {
		// A read that fails for a moment (a lock, or catching a hand-edit
		// half-written) must not look like the user changed the setting.
		// Because giving up cache sharing is permanent, one bad read would
		// cost the whole session. pi reports a failed load as empty settings
		// plus a list of errors, so only a clean load is believed; anything
		// else keeps the last good answer.
		try {
			const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
			if (settings.drainErrors().length === 0) {
				lastReadTransport = settings.getTransport();
			}
		} catch {
			// Environment-level failure: same treatment as an errored load.
		}
		return lastReadTransport ?? "auto";
	}

	function observationHandoffFor(
		ctx: ExtensionContext,
		name: string,
		tools: string[] | undefined,
		instruction: string,
		afterChange: AfterChangeAction | undefined,
	): Pick<Observation, "prompt" | "envelope" | "completionMode"> {
		if (name in DIAGNOSTIC_PROMPTS) {
			return {
				prompt: DIAGNOSTIC_PROMPTS[name as keyof typeof DIAGNOSTIC_PROMPTS],
				completionMode: "tool",
			};
		}
		const deliveryContext = deliveryLedger.contextFor(name);
		const protocol = { afterChange, activeHeads: [...registry.activeSet()], deliveryContext };
		if (!headActs(tools)) {
			return usesSplitObservationHandoff(ctx.model?.api)
				? {
						prompt: instruction,
						envelope: buildEnumeratedJudgeObservationEnvelope(name, deliveryContext),
						completionMode: "enum",
					}
				: {
						prompt: buildEnumeratedJudgeObservationPrompt(name, instruction, deliveryContext),
						completionMode: "enum",
					};
		}
		if (ctx.model?.api === "anthropic-messages") {
			return {
				prompt: buildAnthropicObservationPrompt(name, instruction, tools, protocol),
				completionMode: "json",
			};
		}
		return usesSplitObservationHandoff(ctx.model?.api)
			? {
					prompt: instruction,
					envelope: buildObservationEnvelope(name, tools, protocol),
					completionMode: "tool",
				}
			: {
					prompt: buildObservationPrompt(name, instruction, tools, protocol),
					completionMode: "tool",
				};
	}

	// The exact request the driver last sent, kept byte for byte so an
	// observation can replay it and be charged as a cache read instead of as
	// new input. responseTimestamp identifies the reply that request produced,
	// which is how the end-of-run trigger tells whether the final message still
	// has to be appended or is already inside the saved request.
	let capturedPayload: unknown = null;
	let responseTimestamp: number | null = null;
	let capturedThisRun = false;
	let awaitingFirstResponseOfRun = true;
	let currentTurnIndex = 0;

	const scheduler = new HeadScheduler<ObservationSeed>({
		shouldRun: (seed) => registry.isActive(seed.head) && seed.branchGeneration === branchGeneration,
		observe: async (seed, signal) => {
			// Delivery facts are resolved here rather than at scheduling time. A
			// waiting slot can sit behind an earlier observation that routes
			// feedback, so facts frozen at scheduling would already be out of
			// date by the time this runs. The head's instruction stays frozen.
			const job: Observation = {
				...seed,
				...observationHandoffFor(seed.ctx, seed.head, seed.tools, seed.instruction, seed.afterChange),
			};
			await observe(job, signal);
		},
		onError: (seed, error) => notifyUser(seed.ctx, `hydra: observe error: ${errorText(error)}`, "error"),
	});
	let shuttingDown = false;

	// The observer's backend session identity for codex observations, one
	// per extension instance; see the sessionId option in runObservationLoop
	// for the constraints it satisfies.
	const observerSessionId = uuidv7();

	// Testing only, and genuinely unsafe. Skips the transport check that
	// normally stops hydra from sharing a cache session with the driver, so the
	// safety tripwire can be fired on purpose and watched end to end. On the
	// default transport this breaks the driver's own conversation, which is
	// exactly what the check exists to prevent, so use a throwaway session.
	// Recipe in docs/architecture.md under "Verifying the tripwire".
	const unsafeForceShare = process.env.HYDRA_UNSAFE_FORCE_SHARE === "1";
	// Cache sharing with the driver, once given up, is never taken back for the
	// rest of this session. A new session, a fork or a resume starts over.
	//
	// The reason is that the damage only goes one way. After the user switches
	// transport, the driver can still be holding a reference that a shared
	// observation has already evicted. Turning sharing back on could hand that
	// dead reference out again and break the driver's conversation, so off is
	// the only safe direction to move in.
	//
	// Three things can turn it off: the first agent_start, the check before
	// each observation, and a driver error at the end of a run. One race is
	// left and accepted. Switching transport while an observation is already
	// in flight can break the driver's next message once, and the error that
	// follows then makes the decision permanent.
	let codexShareLostReason: string | null = null;
	let initialTransportPinned = false;

	// Stats and successful delivery facts, rebuilt from the current session
	// branch on restore. Live queue state never crosses branch navigation.
	const stats = new StatsLog();
	const deliveryLedger = new DeliveryLedger();
	let branchGeneration = 0;
	const warnedProviders = new Set<string>();
	let debugDir: string | null = null;
	let debugSeq = 0;

	function updateFooter(ctx: ExtensionContext) {
		const activeHeads = registry.activeSet();
		const headLabel = activeHeads.length > 0 ? activeHeads.join("+") : "no heads";
		const calls = stats.all();
		if (calls.length === 0) {
			ctx.ui.setStatus("hydra", ctx.ui.theme.fg("muted", `hydra: ${headLabel} | (no obs yet)`));
			return;
		}
		const { cost, meanHit } = stats.cumulative(ctx.model?.api);
		const lastHit = calls[calls.length - 1].hitRatio;
		const { good, fair } = hitBandsFor(ctx.model?.api);
		const hitColor = meanHit === null ? "muted" : meanHit >= good ? "success" : meanHit >= fair ? "warning" : "error";
		const hitLabel = meanHit === null ? "hit n/a (this model)" : `hit ${meanHit.toFixed(1)}% (last ${lastHit.toFixed(1)}%)`;
		ctx.ui.setStatus(
			"hydra",
			ctx.ui.theme.fg("toolTitle", `hydra:${headLabel}`) +
				" " +
				ctx.ui.theme.fg(hitColor, hitLabel) +
				" " +
				ctx.ui.theme.fg("dim", `$${cost.toFixed(4)} (${calls.length} obs)`),
		);
	}

	function restoreFromBranch(ctx: ExtensionContext): boolean {
		branchGeneration++;
		const { calls: restoredCalls, config, deliveries } = parseBranchEntries(ctx.sessionManager.getBranch());
		stats.load(restoredCalls);
		deliveryLedger.restore(deliveries);
		if (config) {
			registry.applyConfig(registryGateway(ctx), config);
		}
		updateFooter(ctx);
		return config !== undefined;
	}

	// One observation's outcome. Judge-only heads return enumerated JSON;
	// acting heads complete through their provider's established channel.
	interface ObserveOutcome {
		response: AssistantMessage;
		usages: ObservationUsage[];
		iterations: number;
		toolsUsed: string[];
		decisions: Decision[] | null;
		selfRemoved: boolean;
		fileStateChanged: boolean;
		loopStopReason: ObservationLoopStopReason;
	}

	interface ObservationToolState {
		completion: Decision | null;
		selfRemoved: boolean;
		fileStateChanged: boolean;
	}

	function flattenUsage(usage: AssistantMessage["usage"]): ObservationUsage {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cost: usage.cost.total,
		};
	}

	async function observe(job: Observation, signal: AbortSignal) {
		if (signal.aborted) return;
		const model = job.ctx.model;
		if (!model) {
			warnOnce(job.ctx, "hydra: no model selected; observations skipped");
			return;
		}
		// Whether a replayed request really lands as a cache read has been
		// measured on two providers only: Anthropic's Messages API and
		// OpenAI's Codex Responses backend. Anywhere else hydra warns once and
		// stays out, because guessing wrong here means paying full price for
		// every observation. docs/architecture.md has the procedure for adding
		// a provider. The OpenAI API-key path uses the same code as codex but
		// is held back for the same reason: nobody has measured it.
		const anthropic = model.provider === "anthropic" && model.api === "anthropic-messages";
		const codex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
		if (!anthropic && !codex) {
			const pair = `${model.provider}/${model.api}`;
			if (!warnedProviders.has(pair)) {
				warnedProviders.add(pair);
				notifyUser(job.ctx, `hydra: observations disabled for ${pair} (cache-parity replay is validated on Anthropic and OpenAI Codex only)`, "warning");
			}
			return;
		}

		// At the end of a run the driver's last message has not been sent
		// anywhere yet, so the observation has to carry it and let pi-ai turn
		// it into provider format. Mid-run the saved request already holds
		// everything. The merging happens in utils.ts. The shape check is also
		// what stops a request captured on one provider from being merged
		// under another after the user switches model mid-run.
		const bindMerge = <T>(guard: (value: unknown) => value is T, merge: (captured: T, built: T) => unknown) => {
			if (!guard(job.payload)) {
				return null;
			}
			const captured = job.payload;
			return (built: unknown) => {
				if (!guard(built)) {
					throw new Error(`unexpected payload shape from provider ${model.provider}`);
				}
				return merge(captured, built);
			};
		};
		const mergeBuilt = anthropic
			? bindMerge(isAnthropicPayload, (captured, built) => mergeObservationPayload(captured, built.messages, job.envelope))
			: bindMerge(isOpenAIResponsesPayload, (captured, built) =>
					mergeOpenAIObservationPayload(captured, built.input, job.envelope),
				);
		if (!mergeBuilt) {
			warnOnce(job.ctx, `hydra: captured payload does not match ${model.api} (model switched mid-run, or pi changed shape); observation skipped`);
			return;
		}

		// The codex backend keys its cache by session id, so running
		// observations under the driver's own id is where the saving comes
		// from: every observation reads what the driver just wrote, about 85%
		// from the very first one, and the end-of-run write warms up the
		// driver's next turn.
		//
		// It is only safe while the driver sends its full conversation every
		// turn, which the "websocket" and "sse" transports do. Such a driver
		// never asks the server to continue from an earlier reply, so there is
		// nothing an observation can knock out from under it. On the other
		// transports there is, and knocking it out makes the driver's next
		// request fail outright. That has been reproduced; the numbers are in
		// docs/architecture.md.
		//
		// The transport is checked again before every observation, because the
		// user can change it mid-session, and the decision only ever moves
		// toward hydra using its own separate session, never back.
		let codexSessionId: string | undefined;
		if (codex) {
			if (!unsafeForceShare) {
				codexShareLostReason ??= classifyCodexShareLoss(driverTransport(job.ctx));
			}
			if (codexShareLostReason === null) {
				codexSessionId = job.ctx.sessionManager.getSessionId();
			} else {
				codexSessionId = observerSessionId;
				const advice = codexShareLostReason.startsWith("pi transport")
					? ' Full cache sharing needs { "transport": "websocket" } in pi\'s settings.json from session start.'
					: "";
				warnOnce(
					job.ctx,
					`hydra: codex observations run in their own cache scope (paying the driver context once, plus re-pays after idle pauses) because of ${codexShareLostReason}.${advice}`,
				);
			}
		}

		const auth = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const reason = auth.ok ? "no API key" : auth.error;
			notifyUser(job.ctx, `hydra: no credentials for ${model.provider}: ${reason}`, "warning");
			return;
		}

		const onPayload = (built: unknown) => {
			const merged = mergeBuilt(built);
			if (debugDir) {
				// A diagnostic must never kill the observation it diagnoses:
				// on any write failure, drop the dump dir and keep observing.
				const stem = `${Date.now()}-${job.head}-${debugSeq++}`;
				try {
					writeFileSync(join(debugDir, `hydra-driver-${stem}.json`), JSON.stringify(job.payload, null, 2));
					writeFileSync(join(debugDir, `hydra-observation-${stem}.json`), JSON.stringify(merged, null, 2));
				} catch (error) {
					debugDir = null;
					job.ctx.ui.notify(`hydra: debug dump failed (${errorText(error)}); dumping disabled`, "warning");
				}
			}
			return merged;
		};

		// When login supplies its own server address, pi swaps that address into
		// the model before sending. The session model here has not been through
		// that swap, so without this an observation would skip a gateway the
		// driver's own requests go through. The value is checked rather than
		// trusted because older pi versions do not return it at all and the cast
		// is only a compile-time claim.
		//
		// Never tested against a real gateway; worked out from reading pi's
		// source. Also read once per observation, so an address that changes
		// part-way through a run is not picked up. The API key is handled the
		// same way.
		const authBaseUrl = (auth as { baseUrl?: unknown }).baseUrl;
		const observationModel =
			typeof authBaseUrl === "string" && authBaseUrl.length > 0
				? { ...model, baseUrl: authBaseUrl }
				: model;

		const t0 = Date.now();
		const outcome =
			job.completionMode === "enum"
				? await runJudgeObservation(job, observationModel, auth.apiKey, auth.headers, codexSessionId, onPayload, signal)
				: await runObservationLoop(job, observationModel, auth.apiKey, auth.headers, codexSessionId, onPayload, signal);
		if (!outcome || signal.aborted || job.branchGeneration !== branchGeneration) {
			return;
		}
		const {
			response,
			usages,
			iterations,
			toolsUsed,
			decisions: outcomeDecisions,
			selfRemoved,
			fileStateChanged,
			loopStopReason,
		} = outcome;
		const summary = summarizeLoopUsage(usages);

		// A zero-usage, zero-content response is a provider hiccup (e.g. an
		// overload surfaced as an empty result), not an observation.
		if (summary.input + summary.cacheRead + summary.cacheWrite === 0 && response.content.length === 0) {
			notifyUser(job.ctx, "hydra: observation call returned empty response (provider overloaded?)", "warning");
			return;
		}

		const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		// A head that removes itself is finished by definition. The removal has
		// already been reported to the user, and asking a head that no longer
		// exists for a decision would only be slower and open a race.
		let decisions = outcomeDecisions;
		if ((!decisions || decisions.length === 0) && selfRemoved) {
			decisions = [{ action: "noop", reason: "completed by self-removal", message: "" }];
		}
		if ((!decisions || decisions.length === 0) && job.completionMode === "json") {
			const parsed = parseDecision(text);
			decisions = parsed ? [parsed] : null;
		}
		if (decisions && decisions.length > 0 && job.completionMode === "json") {
			decisions = [applyAfterChangeDelivery(decisions[0], job.afterChange, fileStateChanged)];
		}
		if (!decisions || decisions.length === 0) {
			const stopped = decisionFromLoopStopReason(loopStopReason);
			decisions = stopped ? [stopped] : null;
		}
		if (!decisions || decisions.length === 0) {
			const reason =
				job.completionMode === "enum"
					? "unparseable enumerated decision"
					: job.completionMode === "json"
						? "unparseable Anthropic decision"
						: "missing completion tool call";
			warnOnce(
				job.ctx,
				job.completionMode === "enum"
					? `hydra: ${job.head} answered with an unparseable findings list; recorded as noop`
					: job.completionMode === "json"
					? `hydra: ${job.head} answered with an unparseable JSON decision; recorded as noop`
					: `hydra: ${job.head} ended without complete_observation; recorded as noop`,
			);
			decisions = [{ action: "noop", reason, message: "" }];
		}
		const primaryDecision = decisions.reduce((selected, candidate) => {
			const urgency: Record<Action, number> = { noop: 0, print: 1, queue: 2, steer: 3, interrupt: 4 };
			return urgency[candidate.action] > urgency[selected.action] ? candidate : selected;
		});

		const call: HydraCall = {
			timestamp: Date.now(),
			turnIndex: job.turnIndex,
			head: job.head,
			kind: job.kind,
			api: model.api,
			action: primaryDecision.action,
			actions: decisions.length > 1 ? decisions.map((decision) => decision.action) : undefined,
			input: summary.input,
			output: summary.output,
			cacheRead: summary.cacheRead,
			cacheWrite: summary.cacheWrite,
			cost: summary.cost,
			durationMs: Date.now() - t0,
			hitRatio: summary.hitRatio,
			rawResponse:
				job.completionMode === "enum"
					? text.length > 200
						? `${text.slice(0, 200)}…`
						: text
					: outcomeDecisions !== null
					? JSON.stringify({
							action: "complete_observation",
							delivery: outcomeDecisions[0].action === "noop" ? "none" : outcomeDecisions[0].action,
							message: outcomeDecisions[0].message,
						})
					: text.length > 200
						? `${text.slice(0, 200)}…`
						: text,
			iterations: iterations > 1 ? iterations : undefined,
			toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
		};
		stats.record(call);
		pi.appendEntry<HydraCall>("hydra-call", call);

		registry.revertDiagnosticAfterFire(registryGateway(job.ctx), job.head);
		updateFooter(job.ctx);

		// A decision formed on an outdated snapshot may steer but no longer
		// abort: the driver has already moved on.
		for (const decision of decisions) {
			routeDecision(job.ctx, decision, job.head, job.payload !== capturedPayload);
		}
	}

	// Judge-only heads make one call and run no tools. Output that will not
	// parse is recorded as "did nothing" rather than spending another turn
	// asking for a correction or guessing at a half-read answer.
	//
	// A null header value means "remove this header", not "no value set". The
	// set is passed through untouched: filtering or defaulting the nulls away
	// would put back a header pi meant to strip.
	async function runJudgeObservation(
		job: Observation,
		model: Model<"anthropic-messages" | "openai-codex-responses">,
		apiKey: string,
		headers: ProviderHeaders | undefined,
		sessionId: string | undefined,
		onPayload: (built: unknown) => unknown,
		signal: AbortSignal,
	): Promise<ObserveOutcome | null> {
		const transport = resolveStreamSimple(job.ctx, model);
		const prompt: Message = {
			role: "user",
			content: [{ type: "text", text: job.prompt }],
			timestamp: Date.now(),
		};
		const baseMessages: Message[] = job.assistant ? [job.assistant] : [];
		const usages: ObservationUsage[] = [];

		const call = async (messages: Message[]): Promise<AssistantMessage> => {
			if (signal.aborted) throw new Error("observation aborted");
			let freshApiKey = apiKey;
			let freshHeaders = headers;
			try {
				const fresh = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (fresh.ok && fresh.apiKey) {
					freshApiKey = fresh.apiKey;
					freshHeaders = fresh.headers;
				}
			} catch {
				// The already-resolved credential remains the safe fallback.
			}
			const options = {
				apiKey: freshApiKey,
				headers: freshHeaders,
				sessionId,
				transport: model.api === "openai-codex-responses" ? ("websocket" as const) : undefined,
				onPayload,
				signal,
			};
			const response = await transport(model, { systemPrompt: "", messages, tools: [] }, options).result();
			usages.push(flattenUsage(response.usage));
			return response;
		};

		let response: AssistantMessage;
		try {
			response = await call([...baseMessages, prompt]);
			if (signal.aborted || response.stopReason === "error" || response.stopReason === "aborted") {
				if (!signal.aborted) {
					notifyUser(
						job.ctx,
						`hydra: observation failed: ${response.errorMessage ?? response.stopReason}${observationFailureHint(transport, response.errorMessage ?? "")}`,
						"error",
					);
				}
				return null;
			}
			const parsed = parseEnumeratedDecision(
				response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
			);
			return {
				response,
				usages,
				iterations: 1,
				toolsUsed: [],
				decisions: parsed.decisions,
				selfRemoved: false,
				fileStateChanged: false,
				loopStopReason: null,
			};
		} catch (error) {
			if (!signal.aborted) {
				notifyUser(job.ctx, `hydra: observation failed: ${errorText(error)}${observationFailureHint(transport, errorText(error))}`, "error");
			}
			return null;
		}
	}

	// Heads that can act run through pi's own agent loop instead of a copy of
	// it, so checking tool arguments, reporting unknown tools, deciding what
	// runs in parallel, and handling cancellation all stay pi's code and keep
	// working as pi changes.
	//
	// Every call the loop makes still goes through the same merging as a plain
	// observation, so the driver's conversation stays a cache read and the
	// head's own turns are only paid for once. See utils.ts.
	async function runObservationLoop(
		job: Observation,
		model: Model<"anthropic-messages" | "openai-codex-responses">,
		apiKey: string,
		headers: ProviderHeaders | undefined,
		sessionId: string | undefined,
		onPayload: (built: unknown) => unknown,
		signal: AbortSignal,
	): Promise<ObserveOutcome | null> {
		const transport = resolveStreamSimple(job.ctx, model);
		const prompt: Message = {
			role: "user",
			content: [{ type: "text", text: job.prompt }],
			timestamp: Date.now(),
		};
		const usages: ObservationUsage[] = [];
		const toolsUsed: string[] = [];
		let loopGuard = { iterations: 0 };
		const toolState: ObservationToolState = {
			completion: null,
			selfRemoved: false,
			fileStateChanged: false,
		};
		let loopStopReason: ObservationLoopStopReason = null;
		// Whether this observation is running inside the driver's own session.
		// Fixed for the whole loop, and the reason the loop can be stopped by
		// sharing being given up.
		const sharedSession = sessionId !== undefined && sessionId !== observerSessionId;
		let stoppedForShareLoss = false;
		let messages: Awaited<ReturnType<typeof runAgentLoop>>;
		try {
			messages = await runAgentLoop(
				[prompt],
				{
					systemPrompt: "",
					messages: job.assistant ? [job.assistant] : [],
					tools: observationTools(job.ctx, job.tools, job, toolState),
				},
				{
					model,
					apiKey,
					headers,
					// An OAuth token can expire inside a long acting-head loop;
					// re-resolve per provider call, exactly as the driver does
					// (contract: must not throw).
					getApiKey: async () => {
						if (signal.aborted) return undefined;
						try {
							const fresh = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
							return fresh.ok ? (fresh.apiKey ?? undefined) : undefined;
						} catch {
							return undefined;
						}
					},
					// Codex only. Whether this is the driver's session id or
					// hydra's own is decided in observe().
					//
					// Always a v7 id: on 2026-07-13 a missing or v4 id was
					// measured getting routed to a free tier that does not
					// exist. That did not happen again the next day, but a v7
					// id costs nothing and matches what pi generates anyway.
					//
					// Always plain websocket, never the default. The default
					// asks the server to continue from an earlier reply, and
					// another request in the same session can invalidate that
					// part-way through the loop. SSE would avoid the same
					// problem but was measured being refused outright, while
					// websocket has never misbehaved.
					sessionId,
					transport: model.api === "openai-codex-responses" ? "websocket" : undefined,
					onPayload,
					// Our tail messages are plain LLM messages already; drop
					// anything else defensively (contract: must not throw).
					convertToLlm: (agentMessages) =>
						agentMessages.filter(
							(message): message is Message =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						),
					// Finishing has to be the only thing the head does in that
					// turn. Otherwise it could declare a result in the same
					// breath as an action that then fails, and the failure
					// would be hidden behind a decision already accepted.
					beforeToolCall: async ({ assistantMessage, toolCall, args }) => {
						if (toolCall.name !== "hydra" || !isTerminalHydraAction(args, job.head)) {
							return undefined;
						}
						const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
						if (calls.length !== 1) {
							return {
								block: true,
								reason:
									"Terminal hydra actions must be the only tool call in their turn. Finish the other work, inspect its results, then call the terminal action alone.",
							};
						}
						return undefined;
					},
					// Not a cost limit. Stops a loop that is never going to
					// reach a decision, and stops early if the head is turned
					// off part-way through. A loop running inside the driver's
					// own session also stops the moment sharing is given up,
					// so a transport change mid-loop cannot leave a head
					// writing into the driver's session for another 25 turns.
					shouldStopAfterTurn: () => {
						let shareLost = false;
						if (sharedSession) {
							if (!unsafeForceShare) {
								codexShareLostReason ??= classifyCodexShareLoss(driverTransport(job.ctx));
							}
							shareLost = codexShareLostReason !== null;
						}
						const advanced = advanceObservationLoopGuard(loopGuard, {
							shareLost,
							completed: toolState.completion !== null || toolState.selfRemoved,
							headActive: registry.isActive(job.head),
							maxIterations: MAX_TOOL_ITERATIONS,
						});
						loopGuard = advanced.state;
						loopStopReason = advanced.stopReason;
						if (advanced.stopReason === "share-loss") {
							stoppedForShareLoss = true;
						}
						return advanced.stopReason !== null;
					},
					afterToolCall: async (event) => {
						if (signal.aborted) return undefined;
						const hydraAction =
							event.toolCall.name === "hydra" &&
							typeof event.toolCall.arguments === "object" &&
							event.toolCall.arguments !== null
								? (event.toolCall.arguments as { action?: unknown }).action
								: undefined;
						if (hydraAction !== "complete_observation") {
							toolsUsed.push(event.toolCall.name);
						}
						toolState.fileStateChanged ||=
							!event.isError && (event.toolCall.name === "write" || event.toolCall.name === "edit");
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
					transport,
				);
		} catch (error) {
			if (!signal.aborted) {
				notifyUser(
					job.ctx,
					`hydra: observation loop failed: ${errorText(error)}${observationFailureHint(transport, errorText(error))}`,
					"error",
				);
			}
			return null;
		}

		const response = [...messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
		if (!response) {
			notifyUser(job.ctx, "hydra: observation loop produced no response", "warning");
			return null;
		}
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			if (!signal.aborted) {
				notifyUser(
					job.ctx,
					`hydra: observation loop failed: ${response.errorMessage ?? "aborted"}${observationFailureHint(transport, response.errorMessage ?? "")}`,
					"error",
				);
			}
			return null;
		}
		if (stoppedForShareLoss && response.stopReason === "toolUse") {
			job.ctx.ui.notify(
				`hydra: ${job.head} wound down after ${loopGuard.iterations} turn${loopGuard.iterations === 1 ? "" : "s"} (codex cache sharing lost mid-loop)`,
				"warning",
			);
		} else if (
			response.stopReason === "toolUse" &&
			toolState.completion === null &&
			!toolState.selfRemoved &&
			registry.isActive(job.head)
		) {
			job.ctx.ui.notify(`hydra: ${job.head} hit ${MAX_TOOL_ITERATIONS} turns without deciding; wound down`, "warning");
		}
		return {
			response,
			usages,
			iterations: loopGuard.iterations,
			toolsUsed,
			decisions: toolState.completion ? [toolState.completion] : null,
			selfRemoved: toolState.selfRemoved,
			fileStateChanged: toolState.fileStateChanged,
			loopStopReason,
		};
	}

	// The head uses pi's own tools, in the driver's working directory. Two
	// writes to the same file are queued rather than racing, and that queue is
	// shared with the driver because both end up using the same copy of pi's
	// code.
	//
	// What the model is offered comes from the replayed request, so it always
	// matches what the driver had. A head file's `tools:` list then narrows
	// what will actually run. Anything outside it gets pi's ordinary "tool not
	// found" answer and the head carries on.
	let standardObservationTools: AgentTool[] | null = null;
	function observationTools(
		ctx: ExtensionContext,
		allowed: string[] | undefined,
		job: Observation,
		state: ObservationToolState,
	): AgentTool[] {
		if (!standardObservationTools) {
			standardObservationTools = [
				createReadTool(ctx.cwd),
				createBashTool(ctx.cwd),
				createEditTool(ctx.cwd),
				createWriteTool(ctx.cwd),
				createGrepTool(ctx.cwd),
				createFindTool(ctx.cwd),
				createLsTool(ctx.cwd),
			];
		}
		const workTools =
			allowed === undefined ? standardObservationTools : standardObservationTools.filter((tool) => allowed.includes(tool.name));
		// Every head gets this tool, including judge-only ones, because it is
		// how a head reports its decision. Permission is checked per action
		// instead, so there is only one tool for a model to learn rather than
		// a separate observer-only variant.
		return [
			...workTools,
			{
				name: hydraToolDefinition.name,
				label: hydraToolDefinition.label,
				description: hydraToolDefinition.description,
				parameters: hydraToolDefinition.parameters,
				execute: (toolCallId, params, toolSignal, _onUpdate) =>
					executeObservationHydra(
						toolCallId,
						params as RawHydraToolParams,
						toolSignal,
						ctx,
						job,
						state,
					),
			} satisfies AgentTool,
		];
	}

	// Every file a head writes gets a one-line note, so the driver is never
	// surprised by files changing under it. This is a record of what happened,
	// not the head's opinion. Files written from inside a head's bash commands
	// are not caught here. Known limitation.
	function announceWrite(job: Observation, toolCall: ToolCall) {
		if (toolCall.name !== "write" && toolCall.name !== "edit") {
			return;
		}
		const path = typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "a file";
		const details: FeedbackDetails = { head: job.head, action: "queue", reason: "head file write" };
		pi.sendMessage(
			{
				customType: "hydra-feedback",
				content: `[${job.head}] ${toolCall.name === "write" ? "wrote" : "edited"} ${path}`,
				display: true,
				details,
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	function deliveryGateway(ctx: ExtensionContext): DeliveryGateway {
		return {
			isIdle: () => ctx.isIdle(),
			abort: () => ctx.abort(),
			notify: (message, level) => ctx.ui.notify(message, level),
			sendUserMessage: (content, options) => pi.sendUserMessage(content, options),
			sendMessage: (message, options) => pi.sendMessage(message, options),
			persist: (entry) => pi.appendEntry<PersistedDelivery>("hydra-delivery", entry),
		};
	}

	function routeDecision(ctx: ExtensionContext, decision: Decision, decisionHead: string, staleSnapshot: boolean) {
		// In a headless run the session is already being torn down at this
		// point, so starting a new driver turn here would race the teardown.
		// The feedback is saved for the next turn instead. Interactive
		// sessions are not shutting down yet, so they are unaffected.
		const routed =
			shuttingDown && (decision.action === "steer" || decision.action === "interrupt")
				? { ...decision, action: "queue" as const, reason: `${decision.reason}; queued during shutdown` }
				: decision;
		routeFeedback(deliveryLedger, deliveryGateway(ctx), routed, decisionHead, staleSnapshot);
	}

	// One observation per active head, all from the same captured snapshot.
	// An empty set observes nothing.
	function scheduleObservations(ctx: ExtensionContext, kind: ObserveKind, assistant: AssistantMessage | null) {
		for (const name of registry.activeSet()) {
			const tools = registry.headTools(name);
			const head = registry.get(name);
			scheduler.schedule({
				ctx,
				payload: capturedPayload,
				assistant,
				turnIndex: currentTurnIndex,
				head: name,
				instruction: head?.prompt ?? "",
				afterChange: head?.afterChange,
				tools,
				kind,
				branchGeneration,
			});
		}
	}

	pi.on("session_start", (_event, ctx) => {
		const gateway = registryGateway(ctx);
		registry.discover(gateway, ctx.cwd);
		const restored = restoreFromBranch(ctx);
		// A flag on this launch beats whatever was saved, because it is what
		// the user just asked for. A flag-chosen set is then saved, since it
		// is the only way to configure a headless run. Heads that started
		// themselves are not saved, so a later session reads the files again.
		const flag = pi.getFlag("hydra-heads");
		if (typeof flag === "string" && flag.length > 0) {
			if (flag.trim() === "none") {
				registry.clearHeadSet(gateway);
			} else if (!registry.setHeadSet(gateway, parseHeadList(flag))) {
				ctx.ui.notify(`hydra: --hydra-heads matched nothing; observing with ${registry.activeSet().join("+") || "no heads"}`, "warning");
			}
		} else if (!restored) {
			registry.applyAutostart();
		}
		updateFooter(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		// Branch navigation changes which hydra entries are in scope.
		restoreFromBranch(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		awaitingFirstResponseOfRun = true;
		capturedThisRun = false;
		// The sharing decision is fixed on the first run, which is the closest
		// an extension can get to the moment pi built the driver from the same
		// settings. Editing the settings file later does not change the
		// running driver, so a mid-session switch must not start sharing with
		// a driver that is still working the old way. An edit made in the gap
		// before the first prompt can still slip through, which costs at most
		// one broken message, the same as the race described at
		// codexShareLostReason.
		if (!initialTransportPinned) {
			initialTransportPinned = true;
			if (!unsafeForceShare) {
				codexShareLostReason ??= classifyCodexShareLoss(driverTransport(ctx));
			}
		}
		// Pick up head edits made since the last run (the in-session tuning loop).
		registry.discover(registryGateway(ctx), ctx.cwd);
	});

	pi.on("turn_start", (event) => {
		currentTurnIndex = event.turnIndex;
	});

	pi.on("before_provider_request", (event) => {
		if (registry.activeSet().length === 0) {
			// Throw the old snapshot away rather than keeping it. An
			// observation still running from before must count as out of date,
			// and a head added part-way through must not treat the old
			// snapshot as current.
			capturedPayload = null;
			responseTimestamp = null;
			return;
		}
		// Capture the driver's exact bytes; never modify them.
		capturedPayload = structuredClone(event.payload);
		responseTimestamp = null;
		capturedThisRun = true;
	});

	// The driver's answer has started arriving, which on Anthropic is the
	// moment its request lands in the cache. Replaying it now costs almost
	// nothing and the head's decision arrives while the answer is still being
	// written. On OpenAI the timing is looser: the observation reads whatever
	// is cached so far and pays for the rest, which is slower and dearer but
	// still works.
	//
	// The first request of a run is skipped, because the observation at the
	// end of the previous run has already looked at everything before it.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role === "user") {
			const content = plainMessageText(event.message.content);
			if (content !== null) {
				consumeDeliveredMessage(deliveryLedger, deliveryGateway(ctx), { role: "user", content });
			} else {
				deliveryLedger.discardIdleUserDeliveries();
			}
		} else if (event.message.role === "custom" && event.message.customType === "hydra-feedback") {
			const content = plainMessageText(event.message.content);
			if (content !== null) {
				consumeDeliveredMessage(deliveryLedger, deliveryGateway(ctx), {
					role: "custom",
					customType: event.message.customType,
					content,
				});
			}
		}
		if (event.message.role !== "assistant") {
			return;
		}
		// The first reply after a capture is that request's own answer.
		// Remembering when it arrived is how the end-of-run trigger later
		// recognizes it. Recorded even when no heads are active, since a head
		// can be switched on part-way through.
		if (capturedPayload && responseTimestamp === null) {
			responseTimestamp = (event.message as AssistantMessage).timestamp ?? null;
		}
		if (registry.activeSet().length === 0 || !capturedPayload) {
			return;
		}
		if (awaitingFirstResponseOfRun) {
			awaitingFirstResponseOfRun = false;
			return;
		}
		scheduleObservations(ctx, "piggyback", null);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const orphaned = deliveryLedger.settle();
		if (orphaned.length > 0) {
			ctx.ui.notify(
				`hydra: ${orphaned.length} feedback ${orphaned.length === 1 ? "delivery" : "deliveries"} never reached the driver and was removed from pending context`,
				"warning",
			);
		}
	});

	// The agent has handed control back to the user, so the last thing it said
	// will not reach the cache until the user types again. The observation
	// carries that message itself. Runs that produced nothing worth reviewing,
	// such as a bare command or an immediate cancel, schedule nothing.
	pi.on("agent_end", (event, ctx) => {
		// The one error that is known to mean hydra has broken the driver.
		// What the backend actually evicts is not visible from here, so any
		// such error from the driver, whatever caused it, ends session sharing
		// for the rest of the session. Backing off costs pennies; getting it
		// wrong a second time costs the user their work. This is recorded even
		// with no heads active, so that switching one on later is still safe.
		// The message is only worth showing when heads exist.
		if (ctx.model?.api === "openai-codex-responses" && codexShareLostReason === null && hasDriverContinuationError(event.messages)) {
			codexShareLostReason = "a driver continuation error (hydra backed off to keep the driver safe)";
			if (registry.activeSet().length > 0) {
				notifyUser(ctx, "hydra: the driver hit a continuation error; codex observations retreat to their own cache scope for the rest of this session", "warning");
			}
		}
		if (registry.activeSet().length === 0 || !capturedPayload || !capturedThisRun) {
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
		shuttingDown = true;
		await scheduler.shutdown(parseShutdownGrace(process.env.HYDRA_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_GRACE_MS));
		// pi cleans up the driver's own connection. When observations fall back
		// to hydra's separate session, that connection is hydra's to close.
		// Leaving it open keeps a headless run alive long after it should have
		// exited.
		cleanupSessionResources(observerSessionId);
	});

	pi.registerMessageRenderer<FeedbackDetails>("hydra-feedback", (message, { expanded }, theme) => {
		const details = message.details;
		const action = details?.action ?? "noop";
		const actionColor =
			action === "interrupt" ? "error" : action === "steer" ? "accent" : action === "queue" ? "warning" : "muted";

		let text =
			theme.fg("accent", "🐍 hydra ") +
			theme.fg("toolTitle", `[${details?.head ?? details?.lens ?? "?"}]`) +
			" " +
			theme.fg(actionColor, `(${action})`) +
			"\n" +
			theme.fg("toolOutput", typeof message.content === "string" ? message.content : "");
		if (expanded && details) {
			text += `\n${theme.fg("dim", `reason: ${details.reason || "(none)"}`)}`;
		}

		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// The driver and every head are shown exactly the same tool. They have to
	// be, or the replayed request would no longer match and the cache saving
	// would be lost. Who may do what is decided here instead: the driver
	// manages heads, any head reports a decision, and only a head allowed the
	// hydra tool may manage heads.
	function executeHeadManagement(params: ManageHeadsParams, ctx: ExtensionContext) {
		const name = params.head.trim();
		const receipt = formatHeadManagementReceipt(params.operation, name, params.message);
		const gateway = registryGateway(ctx);
		registry.discover(gateway, ctx.cwd);
		const activeLabel = () => (registry.activeSet().length > 0 ? registry.activeSet().join(", ") : "none");
		const reply = (text: string, changed = false) => ({
			content: [{ type: "text" as const, text }],
			details: {
				action: params.action,
				operation: params.operation,
				head: name,
				heads: [...registry.activeSet()],
				changed,
			},
		});

		if (params.operation === "add") {
			if (!registry.exists(name)) {
				throw new Error(`Unknown head "${name}". Available: ${registry.names().join(", ") || "none"}.`);
			}
			if (registry.isActive(name)) {
				return reply(`"${name}" is already active. Observing with: ${activeLabel()}.`);
			}
			registry.setHeadSet(gateway, [...registry.activeSet(), name]);
			return reply(`${receipt}\nObserving with: ${activeLabel()}.`, true);
		}

		if (!registry.isActive(name)) {
			return reply(`"${name}" is not active. Observing with: ${activeLabel()}.`);
		}
		const remaining = registry.activeSet().filter((active) => active !== name);
		if (remaining.length > 0) {
			registry.setHeadSet(gateway, remaining);
		} else {
			registry.clearHeadSet(gateway);
		}
		return reply(`${receipt}\nObserving with: ${activeLabel()}.`, true);
	}

	async function executeObservationHydra(
		_toolCallId: string,
		rawParams: RawHydraToolParams,
		_signal: AbortSignal | undefined,
		ctx: ExtensionContext,
		job: Observation,
		state: ObservationToolState,
	) {
		const params = validateHydraToolParams(rawParams);
		if (params.action === "complete_observation") {
			if (state.completion) {
				throw new Error("complete_observation was already accepted for this observation");
			}
			const decision = decisionFromCompletion(params.delivery, params.message);
			if (state.fileStateChanged && job.afterChange === "print" && decision.action !== "print") {
				throw new Error('This head requires delivery "print" with a message after a successful write or edit');
			}
			if (state.fileStateChanged && job.afterChange === "noop" && decision.action !== "noop") {
				throw new Error('This head requires delivery "none" with message "" after a successful write or edit');
			}
			state.completion = decision;
			return {
				content: [{ type: "text" as const, text: "Observation completed." }],
				details: { action: params.action, changed: false },
				terminate: true,
			};
		}

		if (job.tools !== undefined && !job.tools.includes("hydra")) {
			throw new Error(`Head "${job.head}" is not allowed to manage heads`);
		}
		const receipt = formatHeadManagementReceipt(params.operation, params.head, params.message);
		const result = executeHeadManagement(params, ctx);
		const changed = (result.details as { changed?: unknown }).changed === true;
		if (!changed) {
			return result;
		}

		// Observer tool results are hidden from both user and driver. A real
		// set change therefore gets one immediate, mandatory print receipt.
		// Driver-originated calls skip this path because their tool result is
		// already visible.
		ctx.ui.notify(`hydra [${job.head}] ${receipt}`, "info");
		const selfRemoved = params.operation === "remove" && params.head.trim() === job.head;
		state.selfRemoved ||= selfRemoved;
		return { ...result, terminate: selfRemoved };
	}

	const hydraToolDefinition = {
		name: "hydra",
		label: "Hydra",
		description: hydraToolDescription(userHeadDir),
		parameters: hydraToolParameters,
		async execute(
			_toolCallId: string,
			rawParams: RawHydraToolParams,
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const params = validateHydraToolParams(rawParams);
			if (params.action === "complete_observation") {
				throw new Error("complete_observation is only available while hydra is running a head observation");
			}
			return executeHeadManagement(params, ctx);
		},
	};
	pi.registerTool(hydraToolDefinition);

	// A checkbox list of every head found. Hand-built because pi's own picker
	// only allows one choice. Enter applies whatever is ticked, which is the
	// same "this is the new set" behavior as typing the names out, and escape
	// cancels.
	async function openHeadPicker(ctx: ExtensionContext): Promise<void> {
		const items = registry.list().sort((a, b) => a.name.localeCompare(b.name));
		if (items.length === 0) {
			notifyUser(ctx, `hydra: no heads found. Drop a markdown file into ${userHeadDir} (see docs/heads.md).`, "warning");
			return;
		}
		const selection = await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
			let cursor = 0;
			const checked = new Set(registry.activeSet().filter((name) => registry.get(name) !== undefined));

			function handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					done(null);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					done([...checked]);
					return;
				}
				if (matchesKey(data, Key.up)) {
					cursor = (cursor + items.length - 1) % items.length;
				} else if (matchesKey(data, Key.down)) {
					cursor = (cursor + 1) % items.length;
				} else if (matchesKey(data, Key.space)) {
					const name = items[cursor].name;
					if (checked.has(name)) {
						checked.delete(name);
					} else {
						checked.add(name);
					}
				} else {
					return;
				}
				tui.requestRender();
			}

			function render(width: number): string[] {
				const lines: string[] = [];
				lines.push(theme.fg("accent", "hydra heads"));
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					const tags = [
						item.source === "project" ? "project" : null,
						item.autostart ? "autostart" : null,
						headActs(item.tools) ? "acting" : null,
					].filter((tag): tag is string => tag !== null);
					const row =
						(i === cursor ? theme.fg("accent", "❯ ") : "  ") +
						theme.fg(checked.has(item.name) ? "success" : "muted", checked.has(item.name) ? "[x] " : "[ ] ") +
						theme.fg(i === cursor ? "accent" : "toolTitle", item.name) +
						theme.fg("muted", `  ${item.description}`) +
						(tags.length > 0 ? theme.fg("dim", ` (${tags.join(", ")})`) : "");
					lines.push(truncateToWidth(row, width));
				}
				lines.push(theme.fg("dim", " ↑↓ move • space toggle • enter apply • esc cancel"));
				return lines;
			}

			// No render cache to drop, so invalidate has nothing to do.
			return { render, handleInput, invalidate: () => {} };
		});
		if (selection === null) {
			return;
		}
		const gateway = registryGateway(ctx);
		if (selection.length === 0) {
			registry.clearHeadSet(gateway);
			ctx.ui.notify("hydra: no heads active", "info");
			return;
		}
		if (registry.setHeadSet(gateway, selection)) {
			ctx.ui.notify(`hydra: heads=${registry.activeSet().join("+")}`, "info");
		}
	}

	pi.registerCommand("hydra-heads", {
		description: `Pick the active hydra heads: no argument opens the picker, "quality,security" sets them, "none" clears them`,
		getArgumentCompletions: (prefix: string) => {
			// Complete the segment after the last separator, so head sets can be
			// typed as "quality,sec<tab>".
			const split = prefix.match(/^(.*[,\s])?([^,\s]*)$/);
			const base = split?.[1] ?? "";
			const partial = split?.[2] ?? "";
			return [...registry.names(), "none"]
				.filter((name) => name.startsWith(partial))
				.map((name) => {
					const source = registry.get(name)?.source;
					return { value: base + name, label: source === "project" ? `${name} (project)` : name };
				});
		},
		handler: async (args, ctx) => {
			const gateway = registryGateway(ctx);
			registry.discover(gateway, ctx.cwd);
			const trimmed = args.trim();
			if (trimmed === "none") {
				registry.clearHeadSet(gateway);
				ctx.ui.notify("hydra: no heads active", "info");
				return;
			}
			if (trimmed.length === 0) {
				if (ctx.hasUI) {
					await openHeadPicker(ctx);
				} else {
					const roster = registry.list().map((head) => `  ${head.name} (${head.source}): ${head.description}`);
					ctx.ui.notify(
						[`hydra: active: ${registry.activeSet().join(", ") || "none"}`, ...(roster.length > 0 ? ["available:", ...roster] : [`no heads in ${userHeadDir}`])].join("\n"),
						"info",
					);
				}
				return;
			}
			if (registry.setHeadSet(gateway, parseHeadList(trimmed))) {
				ctx.ui.notify(`hydra: heads=${registry.activeSet().join("+")}`, "info");
			}
		},
	});

	pi.registerCommand("hydra-stats", {
		description: "Show hydra observation statistics",
		handler: async (_args, ctx) => {
			const calls = stats.all();
			if (calls.length === 0) {
				ctx.ui.notify("hydra: no observations yet", "info");
				return;
			}
			const { cost, read, write, input, meanHit } = stats.cumulative(ctx.model?.api);
			const counts: Record<Action, number> = { noop: 0, print: 0, queue: 0, steer: 0, interrupt: 0 };
			let totalDuration = 0;
			for (const call of calls) {
				for (const action of call.actions?.length ? call.actions : [call.action]) {
					counts[action]++;
				}
				totalDuration += call.durationMs;
			}
			const recent = calls
				.slice(-10)
				.map(
					(call) =>
						`  turn ${call.turnIndex} ${call.head}${call.kind ? ` [${call.kind}]` : ""} ${
							call.actions?.length ? call.actions.join("+") : call.action
						}${
							call.iterations ? ` (${call.iterations} turns: ${[...new Set(call.toolsUsed ?? [])].join(",") || "no tools"})` : ""
						}  hit=${call.hitRatio.toFixed(1)}%  $${call.cost.toFixed(4)}  ${call.durationMs}ms`,
				)
				.join("\n");
			ctx.ui.notify(
				[
					`hydra stats (${calls.length} observations):`,
					`  mean hit: ${meanHit === null ? "n/a (no observations on this model yet)" : `${meanHit.toFixed(2)}%`}   ← target: ${hitBandsFor(ctx.model?.api).target}`,
					`  total cost: $${cost.toFixed(4)}`,
					`  total cache read: ${read.toLocaleString()} tokens`,
					`  total cache write: ${write.toLocaleString()} tokens`,
					`  total input (uncached): ${input.toLocaleString()} tokens`,
					`  mean duration: ${(totalDuration / calls.length).toFixed(0)}ms`,
					`  decision groups: ${counts.noop} noop / ${counts.print} print / ${counts.queue} queue / ${counts.steer} steer / ${counts.interrupt} interrupt`,
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
				notifyUser(ctx, `hydra: failed to create debug dir: ${errorText(error)}`, "error");
				return;
			}
			debugDir = dir;
			ctx.ui.notify(`hydra: dumping payloads to ${dir}`, "info");
		},
	});
}
