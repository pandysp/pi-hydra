/**
 * hydra: commit-point observation for pi.
 *
 * Watches the driver's conversation through a side model that replays the
 * driver's exact provider payload with one observation prompt appended. Because
 * the prefix is byte-identical, every observation is a prompt-cache read of
 * the entry the driver itself just wrote (97%+ hit ratio). The head
 * answers with a JSON decision naming its finding's delivery (noop, print,
 * queue, steer, or interrupt) which hydra routes back into the session.
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
 *   serialized by pi-ai's own provider code via the onPayload hook, and
 *   moves the driver's message-level cache marker onto it. The fork pays M's
 *   write once and pre-warms the driver's next, human-paced turn.
 *
 * Usage:
 *   pi install git:github.com/pandysp/pi-hydra
 *   /hydra-heads      no argument opens the picker; an argument sets the
 *                     active heads ("quality,security"), `none` clears them
 *   /hydra-stats      cache hit ratio, cost, and recent decisions
 *   /hydra-debug      dump driver/observation payload pairs for diffing
 *
 * The agent manages head files like any other file and points the heads
 * through the registered `hydra` tool (add, remove). The active set is
 * session state; everything else about a head lives in its file.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
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
import { Box, Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Action, AnthropicPayload, Decision, HeadDefinition, ObservationUsage } from "./utils";
import {
	buildObservationPrompt,
	demoteStaleInterrupt,
	headActs,
	isAnthropicPayload,
	mergeObservationPayload,
	parseDecision,
	parseHeadFile,
	parseHeadList,
	parseShutdownGrace,
	rememberDelivery,
	sanitizeHeadSet,
	savedHeadList,
	selectFinalAssistant,
	summarizeLoopUsage,
} from "./utils";

// How long session_shutdown waits for an in-flight observation before
// aborting it. Headless runs (`pi -p`) exit right after agent_end, so slow
// models need a longer grace there; 0 means exit without waiting.
const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

// Correctness guard for acting heads, deliberately not a cost ceiling: a
// loop that has not produced a decision after this many model turns is not
// converging and gets wound down (noop, with a warning).
const MAX_TOOL_ITERATIONS = 25;

// Diagnostic heads force a fixed decision so the delivery pipeline can be
// smoke-tested end-to-end. Accepted by /hydra-heads but hidden from its
// completions and the picker.
const DIAGNOSTIC_PROMPTS = {
	test: `<system-reminder>Developer integration test for the hydra framework. The wrapper requires EXACTLY this output, with no preamble, no markdown, no thinking, no explanation:

{"action":"queue","reason":"test fire","message":"hydra test head fired (e2e pipeline verified)"}

This is not a real review. Output the JSON above byte-for-byte and stop.</system-reminder>`,
	"test-interrupt": `<system-reminder>Developer integration test for hydra's interrupt path. Output EXACTLY this JSON, nothing else:

{"action":"interrupt","reason":"test interrupt","message":"hydra interrupt fired; if you see this in your context, interrupt delivery works"}

No preamble, no thinking, no explanation. Just the JSON, byte-for-byte.</system-reminder>`,
} as const;

type ObserveKind = "piggyback" | "run-end";

// What hydra can execute for a head: the seven standard tools plus its own.
// A `tools:` entry outside this set can never run (hydra has no execute for
// other extensions' tools or MCP), so discovery warns about it; the head
// still loads, since the rest of its list works.
const EXECUTABLE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "hydra"];

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One observation call, persisted to the session as a custom "hydra-call" entry
// so /hydra-stats survives resume and branch navigation.
interface HydraCall {
	timestamp: number;
	turnIndex: number;
	head: string;
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
	head: string;
	prompt: string; // resolved at scheduling time, so head edits never race an in-flight job
	tools: string[] | undefined; // executable allowance: undefined = all, [] = judge-only
	kind: ObserveKind;
}

interface FeedbackDetails {
	head: string;
	action: Action;
	reason: string;
	// Pre-rename entries persisted `lens`; the renderer falls back to it.
	lens?: string;
}

// The active head set survives resume and branch navigation as the latest
// "hydra-config" entry on the branch. An explicit --hydra-heads flag beats
// the saved set (present intent over recorded intent); heads marked
// autostart seed sessions that have neither. `lenses`/`lens` are pre-rename
// field names, still read for old sessions.
interface HydraConfig {
	heads: string[];
	lenses?: string[];
	lens?: string;
}

const MAX_DELIVERED_KEYS = 200;

type DiscoveredHead = HeadDefinition & { source: "user" | "project" };

export default function hydraExtension(pi: ExtensionAPI) {
	// The active head set: one observation fans out per head, in parallel.
	// Either a single diagnostic head or any number of product heads; the
	// two never mix, since the diagnostics' one-shot revert restores
	// productHeads. Empty means hydra observes nothing.
	let activeHeads: string[] = [];
	let productHeads: string[] = [];

	pi.registerFlag("hydra-heads", {
		description: "Initial hydra head set, comma-separated, or `none` (beats the saved session set)",
		type: "string",
	});

	// Heads: one markdown file per head, name and capabilities in the
	// frontmatter, instruction in the body. Two directories, re-read at every
	// agent_start and hydra tool call so edits apply to the next observation
	// without a reload. A project head shadows a same-named user head; both
	// loads are announced, since project files are repo-controlled prompts
	// (consented through pi's folder trust, like everything else in .pi/).
	const userHeadDir = join(getAgentDir(), "hydra");
	let heads = new Map<string, DiscoveredHead>();
	let announcedDiscovery = "";

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

	function findProjectHeadDir(cwd: string): string | null {
		let current = cwd;
		while (true) {
			const candidate = join(current, ".pi", "hydra");
			if (isDirectory(candidate)) {
				return candidate;
			}
			const parent = dirname(current);
			if (parent === current) {
				return null;
			}
			current = parent;
		}
	}

	function loadHeadsFromDir(ctx: ExtensionContext, dir: string, source: "user" | "project"): Map<string, DiscoveredHead> {
		const loaded = new Map<string, DiscoveredHead>();
		let files: string[];
		try {
			files = readdirSync(dir).sort();
		} catch (error) {
			// ENOENT means no heads; anything else (EACCES, ENOTDIR) hides
			// real head files and must not read as deliberate emptiness.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				warnOnce(ctx, `hydra: cannot read head dir ${dir}: ${errorText(error)}`);
			}
			return loaded;
		}
		for (const file of files) {
			if (!file.endsWith(".md")) {
				continue;
			}
			let parsed: ReturnType<typeof parseHeadFile>;
			try {
				parsed = parseHeadFile(readFileSync(join(dir, file), "utf8"));
			} catch (error) {
				warnOnce(ctx, `hydra: failed to read ${join(dir, file)}: ${errorText(error)}`);
				continue;
			}
			if ("error" in parsed) {
				warnOnce(ctx, `hydra: skipping ${join(dir, file)}: ${parsed.error}`);
				continue;
			}
			const { head } = parsed;
			if (head.name in DIAGNOSTIC_PROMPTS) {
				warnOnce(ctx, `hydra: skipping ${join(dir, file)}: "${head.name}" is a reserved diagnostic name`);
				continue;
			}
			if (loaded.has(head.name)) {
				warnOnce(ctx, `hydra: duplicate head "${head.name}" in ${dir}; keeping the first file`);
				continue;
			}
			const unexecutable = head.tools?.filter((tool) => !EXECUTABLE_TOOL_NAMES.includes(tool)) ?? [];
			if (unexecutable.length > 0) {
				warnOnce(
					ctx,
					`hydra: head "${head.name}" lists tools hydra cannot execute: ${unexecutable.join(", ")} (valid: ${EXECUTABLE_TOOL_NAMES.join(", ")})`,
				);
			}
			loaded.set(head.name, { ...head, source });
		}
		return loaded;
	}

	function discoverHeads(ctx: ExtensionContext) {
		const merged = loadHeadsFromDir(ctx, userHeadDir, "user");
		const projectDir = findProjectHeadDir(ctx.cwd);
		const project = projectDir ? loadHeadsFromDir(ctx, projectDir, "project") : new Map<string, DiscoveredHead>();
		const shadowed: string[] = [];
		for (const [name, head] of project) {
			if (merged.has(name)) {
				shadowed.push(name);
			}
			merged.set(name, head);
		}
		heads = merged;

		// Announce project heads once per distinct discovery result, not on
		// every rediscovery (which runs at each agent_start and tool call).
		if (project.size > 0 && projectDir) {
			const signature = `${projectDir}|${[...project.keys()].join(",")}|${shadowed.join(",")}`;
			if (signature !== announcedDiscovery) {
				announcedDiscovery = signature;
				ctx.ui.notify(`hydra: project heads from ${projectDir}: ${[...project.keys()].join(", ")}`, "info");
				if (shadowed.length > 0) {
					notifyUser(ctx, `hydra: project head shadows your user head: ${shadowed.join(", ")}`, "warning");
				}
			}
		}

		// A vanished file must not leave a ghost in the active set; dropping
		// it with a notice beats observing with a head that no longer exists.
		const pruned = activeHeads.filter((name) => headExists(name));
		if (pruned.length !== activeHeads.length) {
			const dropped = activeHeads.filter((name) => !headExists(name));
			notifyUser(ctx, `hydra: head file gone, deactivating: ${dropped.join(", ")}`, "warning");
			activeHeads = pruned;
			productHeads = productHeads.filter((name) => headExists(name));
			updateFooter(ctx);
		}
	}

	function headExists(name: string): boolean {
		return heads.has(name) || name in DIAGNOSTIC_PROMPTS;
	}

	function headNames(): string[] {
		return [...heads.keys()].sort();
	}

	const headCatalog = {
		exists: (name: string) => headExists(name),
		isDiagnostic: (name: string) => name in DIAGNOSTIC_PROMPTS,
	};

	// The one invariant of set changes: productHeads tracks the last set
	// without a diagnostic, so a diagnostic's one-shot revert has a home.
	function adoptHeadSet(headsList: string[]) {
		activeHeads = headsList;
		if (!headsList.some((name) => name in DIAGNOSTIC_PROMPTS)) {
			productHeads = headsList;
		}
	}

	// Apply a head set from any surface (command, picker, flag, tool).
	// Returns false when nothing valid was requested; the current set stays.
	function setHeadSet(ctx: ExtensionContext, requested: string[]): boolean {
		const next = sanitizeHeadSet(requested, headCatalog);
		if (next.unknown.length > 0) {
			notifyUser(ctx, `hydra: unknown head: ${next.unknown.join(", ")}. available: ${headNames().join(", ") || "none"}`, "warning");
		}
		if (next.heads.length === 0) {
			return false;
		}
		adoptHeadSet(next.heads);
		persistConfig();
		updateFooter(ctx);
		return true;
	}

	// The deliberate "observe nothing" state; distinct from setHeadSet, which
	// refuses to empty the set by accident (e.g. a typo'd name).
	function clearHeadSet(ctx: ExtensionContext) {
		adoptHeadSet([]);
		persistConfig();
		updateFooter(ctx);
	}

	function observationPromptFor(name: string, tools: string[] | undefined): string {
		const instruction = heads.get(name)?.prompt ?? "";
		return buildObservationPrompt(name, instruction, tools);
	}

	// A head's executable allowance: diagnostics never act; a head file's
	// omitted `tools:` means everything, `[]` means judging only.
	function headTools(name: string): string[] | undefined {
		if (name in DIAGNOSTIC_PROMPTS) {
			return [];
		}
		return heads.get(name)?.tools;
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

	// Conflating single-slot scheduler, per head: every head has at most one
	// observation in flight and one waiting slot that a newer snapshot
	// overwrites. Observations always run to completion; staleness is bounded
	// to one cycle because the slot always holds the newest snapshot. The
	// granularity is per head (not one global batch) so an acting head's
	// minutes-long tool loop cannot starve the judging heads, and a head busy
	// through a commit point still reviews the newest snapshot when it frees
	// up. session_shutdown awaits the in-flight runs.
	interface HeadRunner {
		pending: Observation | null;
		running: Promise<void> | null;
	}
	const runners = new Map<string, HeadRunner>();
	const lifecycleAbort = new AbortController();

	// Stats, rebuilt from the current session branch on restore.
	let calls: HydraCall[] = [];
	const delivered = new Set<string>();
	const warnedProviders = new Set<string>();
	let debugDir: string | null = null;
	let debugSeq = 0;

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
		const headLabel = activeHeads.length > 0 ? activeHeads.join("+") : "no heads";
		if (calls.length === 0) {
			ctx.ui.setStatus("hydra", ctx.ui.theme.fg("muted", `hydra: ${headLabel} | (no obs yet)`));
			return;
		}
		const { cost, meanHit } = cumulative();
		const lastHit = calls[calls.length - 1].hitRatio;
		const hitColor = meanHit >= 97 ? "success" : meanHit >= 90 ? "warning" : "error";
		ctx.ui.setStatus(
			"hydra",
			ctx.ui.theme.fg("toolTitle", `hydra:${headLabel}`) +
				" " +
				ctx.ui.theme.fg(hitColor, `hit ${meanHit.toFixed(1)}% (last ${lastHit.toFixed(1)}%)`) +
				" " +
				ctx.ui.theme.fg("dim", `$${cost.toFixed(4)} (${calls.length} obs)`),
		);
	}

	function persistConfig() {
		pi.appendEntry<HydraConfig>("hydra-config", { heads: activeHeads });
	}

	function applyConfig(ctx: ExtensionContext, config: HydraConfig) {
		const saved = savedHeadList(config);
		if (saved === null) {
			return;
		}
		if (saved.length === 0) {
			// A deliberately emptied set is respected on restore.
			adoptHeadSet([]);
			return;
		}
		const next = sanitizeHeadSet(saved, headCatalog);
		if (next.unknown.length > 0) {
			notifyUser(ctx, `hydra: saved head no longer exists: ${next.unknown.join(", ")}`, "warning");
		}
		if (next.heads.length > 0) {
			adoptHeadSet(next.heads);
		}
	}

	function restoreFromBranch(ctx: ExtensionContext): boolean {
		calls = [];
		// The dedupe memory belongs to the branch being left behind; carrying
		// it across navigation would silently suppress findings on the new one.
		delivered.clear();
		let config: HydraConfig | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") {
				continue;
			}
			if (entry.customType === "hydra-call") {
				const data = entry.data as (HydraCall & { lens?: string }) | undefined;
				if (data && typeof data === "object") {
					calls.push({ ...data, head: data.head ?? data.lens ?? "?" });
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

	// Cold-start default: the heads whose files say autostart. Consulted only
	// when the session has neither a flag nor a saved set, and deliberately
	// not persisted, so tomorrow's session reads tomorrow's files.
	function applyAutostart() {
		adoptHeadSet([...heads.values()].filter((head) => head.autostart).map((head) => head.name).sort());
	}

	// One observation's outcome. A judging head is the zero-tool case: the
	// loop exits after one turn, so iterations stays 1.
	interface ObserveOutcome {
		response: AssistantMessage;
		usages: ObservationUsage[];
		iterations: number;
		toolsUsed: string[];
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
		const model = job.ctx.model;
		if (!model) {
			warnOnce(job.ctx, "hydra: no model selected; observations skipped");
			return;
		}
		// Cache-parity replay is validated on Anthropic's Messages API only.
		if (model.provider !== "anthropic") {
			if (!warnedProviders.has(model.provider)) {
				warnedProviders.add(model.provider);
				notifyUser(job.ctx, `hydra: observations disabled for provider "${model.provider}" (cache-parity replay is validated on Anthropic only)`, "warning");
			}
			return;
		}
		if (!isAnthropicPayload(job.payload)) {
			warnOnce(job.ctx, "hydra: captured payload has an unexpected shape; observations skipped (pi upgrade?)");
			return;
		}
		const captured = job.payload;

		const auth = await job.ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			const reason = auth.ok ? "no API key" : auth.error;
			notifyUser(job.ctx, `hydra: no credentials for ${model.provider}: ${reason}`, "warning");
			return;
		}

		// Run-end observations carry M so pi-ai's own provider code serializes
		// it; piggyback payloads already contain everything. The onPayload hook
		// receives pi-ai's serialization of these messages and splices it onto
		// the captured prefix; see mergeObservationPayload for the cache story.
		const onPayload = (built: unknown) => {
			if (!isAnthropicPayload(built)) {
				throw new Error(`unexpected payload shape from provider ${model.provider}`);
			}
			const merged = mergeObservationPayload(captured, built.messages);
			if (debugDir) {
				// A diagnostic must never kill the observation it diagnoses:
				// on any write failure, drop the dump dir and keep observing.
				const stem = `${Date.now()}-${job.head}-${debugSeq++}`;
				try {
					writeFileSync(join(debugDir, `hydra-driver-${stem}.json`), JSON.stringify(captured, null, 2));
					writeFileSync(join(debugDir, `hydra-observation-${stem}.json`), JSON.stringify(merged, null, 2));
				} catch (error) {
					debugDir = null;
					job.ctx.ui.notify(`hydra: debug dump failed (${errorText(error)}); dumping disabled`, "warning");
				}
			}
			return merged;
		};

		const t0 = Date.now();
		const outcome = await runObservationLoop(job, model, auth.apiKey, auth.headers, onPayload, signal);
		if (!outcome || signal.aborted) {
			return;
		}
		const { response, usages, iterations, toolsUsed } = outcome;
		const summary = summarizeLoopUsage(usages);

		// A zero-usage, zero-content response is a provider hiccup (e.g. an
		// overload surfaced as an empty result), not an observation.
		if (summary.input + summary.cacheRead + summary.cacheWrite === 0 && response.content.length === 0) {
			notifyUser(job.ctx, "hydra: observation call returned empty response (provider overloaded?)", "warning");
			return;
		}

		const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		// An acting head can stop before its decision (iteration guard, or the
		// head deactivated mid-loop); record that honestly. A head that stops
		// speaking JSON is recorded as noop too, but loudly: silently dead
		// heads would be indistinguishable from genuinely quiet ones.
		let decision: Decision;
		if (response.stopReason === "toolUse") {
			decision = { action: "noop", reason: "loop stopped before deciding", message: "" };
		} else {
			const parsed = parseDecision(text);
			if (!parsed) {
				warnOnce(job.ctx, `hydra: ${job.head} answered with an unparseable decision; recorded as noop`);
			}
			decision = parsed ?? { action: "noop", reason: "unparseable response", message: "" };
		}

		const call: HydraCall = {
			timestamp: Date.now(),
			turnIndex: job.turnIndex,
			head: job.head,
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
			iterations: iterations > 1 ? iterations : undefined,
			toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
		};
		calls.push(call);
		pi.appendEntry<HydraCall>("hydra-call", call);

		// Diagnostic heads are one-shot: revert before routing, otherwise an
		// interrupt delivery re-triggers itself forever (each injected message
		// starts a run whose run-end observation would interrupt again).
		if (job.head in DIAGNOSTIC_PROMPTS && activeHeads.length === 1 && activeHeads[0] === job.head) {
			activeHeads = productHeads;
			persistConfig();
			job.ctx.ui.notify(
				`hydra: diagnostic head "${job.head}" fired once; reverting to ${productHeads.join("+") || "no heads"}`,
				"info",
			);
		}
		updateFooter(job.ctx);

		// A decision formed on an outdated snapshot may steer but no longer
		// abort: the driver has already moved on.
		routeDecision(job.ctx, decision, job.head, job.payload !== capturedPayload);
	}

	// Every observation runs through pi's own agent loop rather than a
	// hand-rolled imitation: argument validation, unknown-tool error results,
	// parallel vs sequential execution policy, and abort discipline stay
	// pi's code and evolve with it. A judging head is not a separate path,
	// just the zero-tool case: it answers its decision in one turn and the
	// loop exits, one provider call exactly like a bare complete(). Every
	// provider call the loop makes flows through the same byte-true merge
	// (onPayload discards the loop's own built context), so the driver
	// prefix stays a pure cache read and any loop turns are cached once by
	// the marker the merge advances; see mergeObservationPayload.
	async function runObservationLoop(
		job: Observation,
		model: Model<"anthropic-messages">,
		apiKey: string,
		headers: Record<string, string> | undefined,
		onPayload: (built: unknown) => unknown,
		signal: AbortSignal,
	): Promise<ObserveOutcome | null> {
		const prompt: Message = {
			role: "user",
			content: [{ type: "text", text: job.prompt }],
			timestamp: Date.now(),
		};
		const usages: ObservationUsage[] = [];
		const toolsUsed: string[] = [];
		let iterations = 0;
		let messages: Awaited<ReturnType<typeof runAgentLoop>>;
		try {
			messages = await runAgentLoop(
				[prompt],
				{ systemPrompt: "", messages: job.assistant ? [job.assistant] : [], tools: observationTools(job.ctx, job.tools) },
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
					// that does not converge on a decision, and wind down early
					// when the head is deactivated mid-loop.
					shouldStopAfterTurn: () => !activeHeads.includes(job.head) || ++iterations >= MAX_TOOL_ITERATIONS,
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
				notifyUser(job.ctx, `hydra: observation loop failed: ${errorText(error)}`, "error");
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
				notifyUser(job.ctx, `hydra: observation loop failed: ${response.errorMessage ?? "aborted"}`, "error");
			}
			return null;
		}
		if (response.stopReason === "toolUse" && activeHeads.includes(job.head)) {
			job.ctx.ui.notify(`hydra: ${job.head} hit ${MAX_TOOL_ITERATIONS} turns without deciding; wound down`, "warning");
		}
		return { response, usages, iterations, toolsUsed };
	}

	// The head executes through pi's own tool implementations at the
	// driver's cwd. write/edit serialize same-file mutations through pi's
	// process-wide per-file queue, shared with the driver because the
	// extension loader aliases @earendil-works/pi-coding-agent to its bundled
	// instance (one module, one queue). The replayed payload's tools array is
	// what the model can call: parity with the driver comes from the replay
	// itself. A head file's `tools:` list narrows what actually executes; a
	// call outside the list (or to another extension's tool, or MCP) gets
	// pi's standard "tool not found" error result and the head moves on.
	let standardObservationTools: AgentTool[] | null = null;
	function observationTools(ctx: ExtensionContext, allowed: string[] | undefined): AgentTool[] {
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
		// Plus hydra's own tool: an acting head may re-crew its peers through
		// the same tool the driver uses.
		const all = [
			...standardObservationTools,
			{
				name: hydraToolDefinition.name,
				label: hydraToolDefinition.label,
				description: hydraToolDefinition.description,
				parameters: hydraToolDefinition.parameters,
				execute: (toolCallId, params, toolSignal, _onUpdate) =>
					hydraToolDefinition.execute(toolCallId, params as HydraToolParams, toolSignal, undefined, ctx),
			} satisfies AgentTool,
		];
		return allowed === undefined ? all : all.filter((tool) => allowed.includes(tool.name));
	}

	// Every head file write also queues a one-line note, so the driver is
	// never surprised by files changing under it. Provenance rather than a
	// finding. Writes that happen inside the head's bash commands are
	// invisible here; documented limitation.
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

	function routeDecision(ctx: ExtensionContext, decision: Decision, decisionHead: string, staleSnapshot: boolean) {
		if (decision.action === "noop" || !decision.message) {
			return;
		}

		// A head reviews overlapping snapshots, so identical findings
		// recur; deliver each one once per head. Diagnostic heads are exempt:
		// their message is fixed by design, and every smoke-test firing must be
		// visible.
		if (!(decisionHead in DIAGNOSTIC_PROMPTS)) {
			const key = `${decisionHead}|${decision.action}|${decision.message}`;
			if (!rememberDelivery(delivered, key, MAX_DELIVERED_KEYS)) {
				return;
			}
		}

		const formatted = `[${decisionHead}] ${decision.message}`;
		const action = demoteStaleInterrupt(decision.action, staleSnapshot);
		const details: FeedbackDetails = { head: decisionHead, action, reason: decision.reason };

		// print must never reach the agent, and pi has no chat message that is
		// rendered but excluded from the LLM context (a deliverAs-less custom
		// message steers a streaming agent and joins the next turn of an idle
		// one), so print is a notification.
		if (action === "print") {
			ctx.ui.notify(`hydra ${formatted}`, "info");
			return;
		}

		// The send APIs return void and attach their own rejection handling;
		// the catch covers their synchronous throws (e.g. a run starting in
		// the instant between the isIdle check and the send).
		try {
			if (action === "steer" || action === "interrupt") {
				// steer: a real user message between turns of the current run.
				// interrupt: pull the cord; abort the in-flight run and deliver
				// the finding as a follow-up, which opens the next run. When the
				// agent is idle there is nothing to steer or abort, so just send.
				if (ctx.isIdle()) {
					pi.sendUserMessage(formatted);
				} else if (action === "interrupt") {
					ctx.abort();
					pi.sendUserMessage(formatted, { deliverAs: "followUp" });
				} else {
					pi.sendUserMessage(formatted, { deliverAs: "steer" });
				}
				return;
			}
			// queue joins the agent's next turn: followUp while the agent
			// streams, the message state directly when it is idle.
			pi.sendMessage(
				{ customType: "hydra-feedback", content: formatted, display: true, details },
				{ deliverAs: "followUp", triggerTurn: false },
			);
		} catch (error) {
			notifyUser(ctx, `hydra: ${action} delivery failed: ${errorText(error)}`, "warning");
		}
	}

	// Run one head's observations to completion, newest snapshot first
	// (conflating whatever piled up while busy). Heads run in parallel with
	// each other: mid-run they are all pure cache reads; at run-end each fork
	// pays M's write (the measured economics are in docs/architecture.md).
	async function runHead(runner: HeadRunner): Promise<void> {
		try {
			while (runner.pending) {
				const job = runner.pending;
				runner.pending = null;
				if (!activeHeads.includes(job.head)) {
					continue; // deactivated while waiting
				}
				try {
					await observe(job, lifecycleAbort.signal);
				} catch (error) {
					if (!lifecycleAbort.signal.aborted) {
						notifyUser(job.ctx, `hydra: observe error: ${errorText(error)}`, "error");
					}
				}
			}
		} finally {
			runner.running = null;
		}
	}

	// One observation per active head, all from the same captured snapshot.
	// An empty set observes nothing.
	function scheduleObservations(ctx: ExtensionContext, kind: ObserveKind, assistant: AssistantMessage | null) {
		for (const name of activeHeads) {
			const tools = headTools(name);
			let runner = runners.get(name);
			if (!runner) {
				runner = { pending: null, running: null };
				runners.set(name, runner);
			}
			runner.pending = {
				ctx,
				payload: capturedPayload,
				assistant,
				turnIndex: currentTurnIndex,
				head: name,
				prompt: observationPromptFor(name, tools),
				tools,
				kind,
			};
			if (!runner.running) {
				runner.running = runHead(runner);
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		discoverHeads(ctx);
		const restored = restoreFromBranch(ctx);
		// An explicit flag on this launch beats the saved set: present intent
		// over recorded intent. Flag-seeded sets persist (they are the only
		// way to configure headless runs); autostart seeding does not, so a
		// resumed session re-reads the files.
		const flag = pi.getFlag("hydra-heads");
		if (typeof flag === "string" && flag.length > 0) {
			if (flag.trim() === "none") {
				clearHeadSet(ctx);
			} else if (!setHeadSet(ctx, parseHeadList(flag))) {
				ctx.ui.notify(`hydra: --hydra-heads matched nothing; observing with ${activeHeads.join("+") || "no heads"}`, "warning");
			}
		} else if (!restored) {
			applyAutostart();
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
		// Pick up head edits made since the last run (the in-session tuning loop).
		discoverHeads(ctx);
	});

	pi.on("turn_start", (event) => {
		currentTurnIndex = event.turnIndex;
	});

	pi.on("before_provider_request", (event) => {
		if (activeHeads.length === 0) {
			// Forget the old snapshot rather than freezing it: an in-flight
			// observation from before the gap must compare as stale (the
			// demotion clamp keys on payload identity), and a head added
			// mid-run must not observe a pre-gap snapshot as fresh.
			capturedPayload = null;
			responseTimestamp = null;
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
	// pure cache read, and the decision lands while the response is still
	// streaming. The run's first request is skipped; the previous run-end
	// observation has already reviewed everything before it.
	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") {
			return;
		}
		// The first assistant message after a capture is that request's own
		// response; remember its timestamp so the run-end trigger can match M
		// by identity. Recorded ahead of the set-size gate: it is bookkeeping,
		// and heads can be added mid-stream.
		if (capturedPayload && responseTimestamp === null) {
			responseTimestamp = (event.message as AssistantMessage).timestamp ?? null;
		}
		if (activeHeads.length === 0 || !capturedPayload) {
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
		if (activeHeads.length === 0 || !capturedPayload || !capturedThisRun) {
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
		const running = [...runners.values()].flatMap((runner) => runner.running ?? []);
		if (running.length > 0) {
			// Clear the timer once the race settles: a pending timeout keeps
			// the headless process alive for the full grace after the
			// observations already finished.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, parseShutdownGrace(process.env.HYDRA_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_GRACE_MS));
			});
			await Promise.race([Promise.all(running), timeout]);
			clearTimeout(timer);
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

	// The agent's hand on the head set. Head files themselves are the
	// agent's to manage with its ordinary file tools; this tool only points
	// the heads, which is the one piece of state not on disk. The definition
	// is named so acting heads can execute it too (observationTools).
	const hydraToolParameters = Type.Object({
		action: StringEnum(["add", "remove"] as const, { description: "What to do" }),
		head: Type.String({ description: "The head name" }),
	});
	type HydraToolParams = Static<typeof hydraToolParameters>;
	const hydraToolDefinition = {
		name: "hydra",
		label: "Hydra",
		description: [
			"Point your hydra heads: `add` puts a head on the active set,",
			"`remove` takes it off (both idempotent; the set is session state). Each",
			"active head independently reviews your full context as you work. Heads",
			`are markdown files in ${userHeadDir} (user) and .pi/hydra (project):`,
			"frontmatter `name:` and `description:` are required; `tools:` is omitted",
			"for all tools, `[]` for a judge-only head, or a comma-separated subset;",
			"`autostart: true` joins fresh sessions; the body is the head's",
			"instruction (one focus, explicit do-NOT boundaries, short). To create or",
			"tune a head, write the file with your file tools, then `add` it: files",
			"are re-discovered on every call. Swap heads when the work changes phase",
			"(design wants devil's-advocate thinking, execution wants quality and",
			"security, review wants simplifier).",
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
				details: { heads: activeHeads },
			});
			const activeLabel = () => (activeHeads.length > 0 ? activeHeads.join(", ") : "none");
			discoverHeads(ctx);
			const name = params.head.trim();
			switch (params.action) {
				case "add": {
					if (!headExists(name)) {
						return reply(`Unknown head "${name}". Available: ${headNames().join(", ") || "none"}.`);
					}
					if (activeHeads.includes(name)) {
						return reply(`"${name}" is already active. Observing with: ${activeLabel()}.`);
					}
					setHeadSet(ctx, [...activeHeads, name]);
					return reply(`Observing with: ${activeLabel()}.`);
				}
				case "remove": {
					if (!activeHeads.includes(name)) {
						return reply(`"${name}" is not active. Observing with: ${activeLabel()}.`);
					}
					const remaining = activeHeads.filter((active) => active !== name);
					if (remaining.length > 0) {
						setHeadSet(ctx, remaining);
					} else {
						clearHeadSet(ctx);
					}
					return reply(`Observing with: ${activeLabel()}.`);
				}
			}
		},
	};
	pi.registerTool(hydraToolDefinition);

	// The /hydra-heads picker: a checkbox list over every discovered head.
	// ui.select is single-choice, so this is a small custom component in the
	// questionnaire example's mold; enter applies the checked set (the same
	// declarative semantics as the typed form), escape cancels.
	async function openHeadPicker(ctx: ExtensionContext): Promise<void> {
		const items = [...heads.values()].sort((a, b) => a.name.localeCompare(b.name));
		if (items.length === 0) {
			notifyUser(ctx, `hydra: no heads found. Drop a markdown file into ${userHeadDir} (see docs/heads.md).`, "warning");
			return;
		}
		const selection = await ctx.ui.custom<string[] | null>((tui, theme, _keybindings, done) => {
			let cursor = 0;
			const checked = new Set(activeHeads.filter((name) => heads.has(name)));

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
		if (selection.length === 0) {
			clearHeadSet(ctx);
			ctx.ui.notify("hydra: no heads active", "info");
			return;
		}
		if (setHeadSet(ctx, selection)) {
			ctx.ui.notify(`hydra: heads=${activeHeads.join("+")}`, "info");
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
			return [...headNames(), "none"]
				.filter((name) => name.startsWith(partial))
				.map((name) => {
					const source = heads.get(name)?.source;
					return { value: base + name, label: source === "project" ? `${name} (project)` : name };
				});
		},
		handler: async (args, ctx) => {
			discoverHeads(ctx);
			const trimmed = args.trim();
			if (trimmed === "none") {
				clearHeadSet(ctx);
				ctx.ui.notify("hydra: no heads active", "info");
				return;
			}
			if (trimmed.length === 0) {
				if (ctx.hasUI) {
					await openHeadPicker(ctx);
				} else {
					const roster = [...heads.values()].map((head) => `  ${head.name} (${head.source}): ${head.description}`);
					ctx.ui.notify(
						[`hydra: active: ${activeHeads.join(", ") || "none"}`, ...(roster.length > 0 ? ["available:", ...roster] : [`no heads in ${userHeadDir}`])].join("\n"),
						"info",
					);
				}
				return;
			}
			if (setHeadSet(ctx, parseHeadList(trimmed))) {
				ctx.ui.notify(`hydra: heads=${activeHeads.join("+")}`, "info");
			}
		},
	});

	pi.registerCommand("hydra-stats", {
		description: "Show hydra observation statistics",
		handler: async (_args, ctx) => {
			if (calls.length === 0) {
				ctx.ui.notify("hydra: no observations yet", "info");
				return;
			}
			const { cost, read, write, input, meanHit } = cumulative();
			const counts: Record<Action, number> = { noop: 0, print: 0, queue: 0, steer: 0, interrupt: 0 };
			let totalDuration = 0;
			for (const call of calls) {
				counts[call.action]++;
				totalDuration += call.durationMs;
			}
			const recent = calls
				.slice(-10)
				.map(
					(call) =>
						`  turn ${call.turnIndex} ${call.head}${call.kind ? ` [${call.kind}]` : ""} ${call.action}${
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
					`  decisions: ${counts.noop} noop / ${counts.print} print / ${counts.queue} queue / ${counts.steer} steer / ${counts.interrupt} interrupt`,
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
