/**
 * Pure helpers for hydra observations.
 * Extracted for testability; no pi or I/O dependencies.
 */

// A decision names its finding's delivery: noop (nothing anywhere), print
// (TUI only), queue (run end), steer (between turns), interrupt (now,
// aborting the run).
export const ACTIONS = ["noop", "print", "queue", "steer", "interrupt"] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * A decision formed on a snapshot the driver has since moved past may not
 * abort the current run: interrupt demotes to steer. The asymmetry favors
 * demotion; a wrong demotion costs one turn of latency, a wrong abort
 * destroys in-flight work.
 */
export function demoteStaleInterrupt(action: Action, staleSnapshot: boolean): Action {
	return action === "interrupt" && staleSnapshot ? "steer" : action;
}

export interface Decision {
	action: Action;
	reason: string;
	message: string;
}

function asDecision(value: unknown): Decision | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const obj = value as { action?: unknown; reason?: unknown; message?: unknown };
	if (typeof obj.action !== "string" || !(ACTIONS as readonly string[]).includes(obj.action)) {
		return null;
	}
	const action = obj.action as Action;
	const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "";
	const message = typeof obj.message === "string" ? obj.message.trim().slice(0, 500) : "";
	// A delivery with nothing to deliver is recorded as the noop it is, so
	// stats never count an interrupt that interrupted nothing.
	if (action !== "noop" && message === "") {
		return { action: "noop", reason: reason ? `${reason} (empty message)` : "empty message", message: "" };
	}
	return { action, reason, message };
}

function tryParseDecision(text: string): Decision | null {
	try {
		return asDecision(JSON.parse(text));
	} catch {
		return null;
	}
}

/**
 * Parse the head's JSON decision, tolerating code fences and surrounding
 * prose. Null means nothing parseable: the caller decides how loudly a head
 * that stopped speaking JSON should fail.
 */
export function parseDecision(text: string): Decision | null {
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	const direct = tryParseDecision(cleaned);
	if (direct) {
		return direct;
	}

	// Embedded in prose: try every balanced {...} span. Brace counting
	// instead of a regex, so a decision whose message itself contains braces
	// still parses.
	for (let start = cleaned.indexOf("{"); start !== -1; start = cleaned.indexOf("{", start + 1)) {
		let depth = 0;
		for (let i = start; i < cleaned.length; i++) {
			if (cleaned[i] === "{") {
				depth++;
			} else if (cleaned[i] === "}" && --depth === 0) {
				const parsed = tryParseDecision(cleaned.slice(start, i + 1));
				if (parsed) {
					return parsed;
				}
				break;
			}
		}
	}

	return null;
}

/**
 * Record a delivery key, evicting the oldest once the set exceeds max.
 * Returns false when the key was already delivered.
 */
export function rememberDelivery(delivered: Set<string>, key: string, max: number): boolean {
	if (delivered.has(key)) {
		return false;
	}
	delivered.add(key);
	if (delivered.size > max) {
		delivered.delete(delivered.values().next().value as string);
	}
	return true;
}

export interface ObservationUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Fold the per-iteration usage of one observation (a judging head makes one
 * call, an acting head one per loop iteration) into stats for a single
 * HydraCall. Totals sum across iterations; the hit ratio comes from the first
 * iteration alone, since that is the replay-parity regression signal and
 * later iterations legitimately pay the loop tail as fresh input.
 */
export function summarizeLoopUsage(usages: ObservationUsage[]): ObservationUsage & { hitRatio: number } {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const usage of usages) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost;
	}
	const first = usages[0];
	const readable = first ? first.input + first.cacheRead + first.cacheWrite : 0;
	return { ...total, hitRatio: readable > 0 ? (first.cacheRead / readable) * 100 : 0 };
}

/** Parse a user-supplied head list ("quality,security" or "quality security"). */
export function parseHeadList(value: string): string[] {
	return [...new Set(value.split(/[\s,]+/).map((name) => name.trim()).filter((name) => name.length > 0))];
}

export interface HeadDefinition {
	name: string;
	description: string;
	/**
	 * Tool names the head may execute. Undefined means every tool the agent
	 * has; an empty array means none (the head judges, never acts).
	 */
	tools?: string[];
	/** Joins the active set at session start when no saved set and no flag exist. */
	autostart?: boolean;
	prompt: string;
}

export function isValidHeadName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== "none";
}

/**
 * Parse a head file: `---` frontmatter carrying the head's identity and
 * capabilities, body carrying the instruction. `name` and `description` are
 * required; a file missing either is skipped (with the returned error as the
 * warning). The filename is storage, not identity.
 */
export function parseHeadFile(rawContent: string): { head: HeadDefinition } | { error: string } {
	const content = rawContent.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!frontmatter) {
		return { error: "no frontmatter (name: and description: are required)" };
	}
	let name: string | undefined;
	let description: string | undefined;
	let tools: string[] | undefined;
	let autostart: boolean | undefined;
	for (const line of frontmatter[1].split("\n")) {
		if (/^\s*- /.test(line)) {
			// A YAML block list would silently parse as an empty value above
			// it; reject loudly instead.
			return { error: `block-style lists are not supported; write "tools: read, write" on one line` };
		}
		if (line.startsWith("name:")) {
			name = line.slice("name:".length).trim();
		} else if (line.startsWith("description:")) {
			description = line.slice("description:".length).trim();
		} else if (line.startsWith("tools:")) {
			// A present-but-empty value ("tools:" or "tools: []") means none;
			// an absent key means all. The two must not collapse into each
			// other. Brackets are optional around a non-empty list.
			const value = line.slice("tools:".length).trim().replace(/^\[/, "").replace(/\]$/, "");
			tools = value === "" ? [] : parseHeadList(value);
		} else if (line.startsWith("autostart:")) {
			autostart = line.slice("autostart:".length).trim() === "true" || undefined;
		}
	}
	if (!name) {
		return { error: "missing name:" };
	}
	if (!isValidHeadName(name)) {
		return { error: `invalid name "${name}" (lowercase kebab-case, "none" is reserved)` };
	}
	if (!description) {
		return { error: "missing description:" };
	}
	const prompt = content.slice(frontmatter[0].length).trim();
	if (prompt.length === 0) {
		return { error: "missing instruction body" };
	}
	return { head: { name, description, tools, autostart, prompt } };
}

/** Whether a head's tools allowance lets it act: undefined means all tools. */
export function headActs(tools: string[] | undefined): boolean {
	return tools === undefined || tools.length > 0;
}

const DECISION_SHAPE = '{"action":"noop|print|queue|steer|interrupt","reason":"\u2264120 chars","message":"\u2264240 chars, empty if noop"}';

/**
 * The wrapper around a head's instruction. Kept SHORT: the driver's context
 * is already cached, so this is the only fresh input the observation pays for
 * per call. Judge-only heads (tools: []) get a hard tool ban: the head
 * sits atop a context saturated with driver tool calls, and anything softer
 * leaks into "let me check" excursions. Acting heads get the tool-permitting
 * variant, with the allowance spelled out when the file narrows it.
 */
export function buildObservationPrompt(head: string, instruction: string, tools: string[] | undefined): string {
	if (headActs(tools)) {
		const allowance = tools === undefined ? "the available tools" : `only these tools: ${tools.join(", ")}`;
		return `<system-reminder>Side watcher with tool access. You may use ${allowance} to check facts or act on your lens; the main agent does not see your tool calls, only files you change and the decision you send. When done, reply with one JSON object, nothing else:
${DECISION_SHAPE}

LENS: ${instruction}

Noop when your work product is the files you wrote. Print a note the user sees but the agent does not. Queue findings that can wait. Steer to put a finding in front of the agent between turns. Interrupt only for emergencies that must stop the line. Don't prefix message with [${head}].</system-reminder>`;
	}
	return `<system-reminder>Side watcher. Reply with one JSON object, nothing else:
${DECISION_SHAPE}

LENS: ${instruction}

Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${head}].</system-reminder>`;
}

export interface HeadCatalog {
	exists(name: string): boolean;
	isDiagnostic(name: string): boolean;
}

/**
 * Resolve a requested head set: drop unknown names, collapse to a single
 * diagnostic when one is present (diagnostics never mix with product heads;
 * their one-shot revert needs an unambiguous set to restore), dedupe the rest.
 */
export function sanitizeHeadSet(requested: string[], catalog: HeadCatalog): { heads: string[]; unknown: string[] } {
	const known = requested.filter((name) => catalog.exists(name));
	const unknown = requested.filter((name) => !catalog.exists(name));
	const diagnostic = known.find((name) => catalog.isDiagnostic(name));
	return { heads: diagnostic ? [diagnostic] : [...new Set(known)], unknown };
}

/**
 * Normalize a persisted config's head field: a `heads` array (an explicit
 * empty array means "no heads" and is respected), the pre-rename `lenses`
 * array or `lens` string from older sessions, or null when the entry carries
 * none of them.
 */
export function savedHeadList(config: { heads?: unknown; lenses?: unknown; lens?: unknown }): string[] | null {
	if (Array.isArray(config.heads)) {
		return config.heads.filter((name): name is string => typeof name === "string");
	}
	if (Array.isArray(config.lenses)) {
		return config.lenses.filter((name): name is string => typeof name === "string");
	}
	if (typeof config.lens === "string") {
		return [config.lens];
	}
	return null;
}

export interface FinalAssistantCandidate {
	role: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	timestamp?: number;
}

/**
 * Pick the run's final assistant message M for the run-end fork: the last
 * usable assistant message, required to BE the captured request's own
 * response. Anything else is already serialized inside the captured payload,
 * and appending it again would duplicate it in the observation's context. Runs
 * whose final generation aborted or errored hit exactly that case and select
 * nothing.
 *
 * Identity is matched on the timestamp recorded at the response's own
 * message_start (null when the captured request never started a response).
 * Wall-clock comparison against the capture time is a coin flip: pi
 * constructs the response message ~1ms before before_provider_request fires.
 */
export function selectFinalAssistant<T extends FinalAssistantCandidate>(
	messages: T[],
	responseTimestamp: number | null,
): T | null {
	if (responseTimestamp === null) {
		return null;
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
			continue;
		}
		if (!Array.isArray(message.content) || message.content.length === 0) {
			continue;
		}
		return message.timestamp === responseTimestamp ? message : null;
	}
	return null;
}

/**
 * Whether a pi transport setting means the driver sends its full input on
 * every request. Full-input drivers never send previous_response_id, so
 * there is no server-side continuation reference for an observation under
 * a shared session to evict — the codex sharing precondition. Deliberately
 * typed over plain strings: settings files hold untrusted input, and
 * anything unrecognized must classify as unsafe.
 */
export function isFullInputTransport(transport: string): boolean {
	return transport === "websocket" || transport === "sse";
}

/**
 * The single owner of the codex share-loss decision: null when the
 * transport keeps sharing safe, otherwise the human-readable reason every
 * gate site records into codexShareLostReason (monotonically, via `??=`).
 * One owner because the reason string doubles as the warnOnce dedup key.
 */
export function classifyCodexShareLoss(transport: string): string | null {
	return isFullInputTransport(transport)
		? null
		: `pi transport "${transport}" (the driver's delta continuation would break under a shared session)`;
}

// The codex continuation-failure signature, tolerant of wording variants
// ("previous_response_id", "could not be found") and of multi-line error
// bodies (s flag). False positives are fenced by the stopReason gate in
// hasDriverContinuationError, and cost only cache economics; a false
// negative costs repeated driver breakage, so match generously.
const CONTINUATION_ERROR = /previous[ _]?response.*not.*found/is;

/**
 * Whether a run's messages contain the codex continuation-failure signature
 * on an errored assistant message: the one known driver-breaking symptom of
 * observing under the driver's session. The tripwire that consumes this
 * permanently downgrades codex observations to their own session.
 */
export function hasDriverContinuationError(messages: FinalAssistantCandidate[]): boolean {
	return messages.some(
		(message) =>
			message.role === "assistant" &&
			message.stopReason === "error" &&
			CONTINUATION_ERROR.test(message.errorMessage ?? ""),
	);
}

/** Shutdown grace from its raw env value: 0 means "don't wait"; unset or invalid falls back. */
export function parseShutdownGrace(raw: string | undefined, fallback: number): number {
	const parsed = raw == null || raw.trim() === "" ? Number.NaN : Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// The slice of an Anthropic Messages payload that hydra reads and rewrites.
// Structural on purpose: the payload arrives as `unknown` from pi's
// before_provider_request hook, and hydra must pass through every field it
// does not understand byte-for-byte.

export interface CacheControl {
	type: string;
	ttl?: string;
}

export interface PayloadBlock {
	type: string;
	text?: string;
	cache_control?: CacheControl;
	[key: string]: unknown;
}

export interface PayloadMessage {
	role: string;
	content: string | PayloadBlock[];
	[key: string]: unknown;
}

export interface AnthropicPayload {
	messages: PayloadMessage[];
	[key: string]: unknown;
}

export function isAnthropicPayload(value: unknown): value is AnthropicPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { messages?: unknown }).messages)
	);
}

/** Remove every message-level marker in place, returning the deepest one removed. */
function stripMessageMarkers(messages: PayloadMessage[]): CacheControl | undefined {
	let stripped: CacheControl | undefined;
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (block.cache_control !== undefined) {
				stripped = block.cache_control;
				delete block.cache_control;
			}
		}
	}
	return stripped;
}

// text, tool_use, and tool_result are the marker-eligible block types here;
// cache_control on a thinking block is an API error.
const MARKABLE_TYPES = ["text", "tool_use", "tool_result"];

function lastMarkableBlock(message: PayloadMessage): PayloadBlock | undefined {
	if (!Array.isArray(message.content)) {
		return undefined;
	}
	for (let i = message.content.length - 1; i >= 0; i--) {
		if (MARKABLE_TYPES.includes(message.content[i].type)) {
			return message.content[i];
		}
	}
	return undefined;
}

/** The deepest markable block across the tail, for the loop-frontier marker. */
function lastMarkableBlockOfTail(tail: PayloadMessage[]): PayloadBlock | undefined {
	for (let i = tail.length - 1; i >= 0; i--) {
		const block = lastMarkableBlock(tail[i]);
		if (block) {
			return block;
		}
	}
	return undefined;
}

/**
 * Merge the observation tail (pi-ai's own serialization of `[M?, prompt,
 * ...tool-loop turns]`) onto the captured driver payload.
 *
 * The captured prefix is replayed byte-true so the fork reads the driver's
 * cache entry exactly. Cache writes happen only at explicit breakpoints, and
 * the budget is four per request (the driver's payload already spends all
 * four), so hydra only ever MOVES the deepest message-level marker, by tail
 * shape:
 *
 * - `[prompt]`: a plain observation. Nothing moves; the captured markers
 *   are replayed byte-true and the prompt stays uncached.
 * - `[M, prompt]`: a run-end fork. The driver's marker (TTL included) rides
 *   M's last markable block: the fork's write pre-warms the driver's next
 *   request, which finds the prefix+M entry via breakpoint walk-back.
 * - longer: a tool loop appended observation turns. The marker advances to the
 *   tail's last markable block, so each loop turn is written once and read
 *   thereafter instead of re-paid as input every iteration. A plain
 *   ephemeral marker, deliberately without the driver's TTL: loop entries
 *   only need to survive until the next iteration, and the prefix+M entry
 *   the first call wrote keeps serving the driver bet.
 *
 * Markers pi-ai placed on the tail are dropped before any of this.
 */
export function mergeObservationPayload(captured: AnthropicPayload, tail: PayloadMessage[]): AnthropicPayload {
	const merged = structuredClone(captured) as AnthropicPayload;
	// Clone the tail before touching it: it is pi-ai's own params object, and
	// the marker handling below must not reach back into it. Markers pi-ai
	// placed on the tail are dropped; hydra owns the marker placement.
	const tailMessages = structuredClone(tail) as PayloadMessage[];
	stripMessageMarkers(tailMessages);
	const anchored = tailMessages[0]?.role === "assistant";
	const loopTurns = tailMessages.length > (anchored ? 2 : 1);
	const target = loopTurns
		? lastMarkableBlockOfTail(tailMessages)
		: anchored
			? lastMarkableBlock(tailMessages[0])
			: undefined;
	if (target) {
		const stripped = stripMessageMarkers(merged.messages);
		target.cache_control = loopTurns ? { type: "ephemeral" } : (stripped ?? { type: "ephemeral" });
	}
	merged.messages = [...merged.messages, ...tailMessages];
	return merged;
}

// OpenAI Responses payloads (`input` items instead of `messages`), same
// structural stance: `input` is the one field the merge touches, everything
// else passes through byte-for-byte.

export interface OpenAIResponsesPayload {
	input: unknown[];
	[key: string]: unknown;
}

export function isOpenAIResponsesPayload(value: unknown): value is OpenAIResponsesPayload {
	return (
		typeof value === "object" &&
		value !== null &&
		Array.isArray((value as { input?: unknown }).input)
	);
}

/** Remove every explicit cache breakpoint from the items' content blocks in place. */
function stripPromptCacheBreakpoints(items: unknown[]): void {
	for (const item of items) {
		const content = (item as { content?: unknown } | null)?.content;
		if (!Array.isArray(content)) {
			continue;
		}
		for (const block of content) {
			if (typeof block === "object" && block !== null) {
				delete (block as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint;
			}
		}
	}
}

/**
 * Merge the observation tail (pi-ai's own serialization of `[M?, prompt,
 * ...tool-loop turns]`) onto the captured driver payload, OpenAI Responses
 * shape.
 *
 * The captured prefix is replayed byte-true — `prompt_cache_key`, `store`,
 * `instructions`, everything. Unlike Anthropic, no marker ever moves:
 * GPT-5.6 caching runs in implicit mode, where the server itself
 * breakpoints each request's latest message, so each observation writes
 * its own frontier and the next one reads it — the economics the Anthropic
 * merge arranges by hand with `cache_control` moves. Whether an
 * observation can also read the entries the DRIVER wrote depends on
 * backend routing hydra does not control; observing under the driver's
 * own session id makes it reliable, which is the transport-gated session
 * strategy decided in index.ts (see the OpenAI section of
 * docs/architecture.md for the measurements).
 *
 * A marker-style run-end pre-warm of the driver has no expressible form
 * here: explicit breakpoints are legal only on input blocks (`input_text`,
 * `input_image`, `input_file`), never on assistant output. The fork still
 * observes M cheaply either way.
 *
 * Explicit breakpoints pi-ai might one day place on the tail are dropped:
 * hydra owns marker placement, and on this provider that means none.
 */
export function mergeOpenAIObservationPayload(captured: OpenAIResponsesPayload, tail: unknown[]): OpenAIResponsesPayload {
	// Clone the tail before stripping: it is pi-ai's own request body. The
	// captured prefix is never mutated here (unlike the Anthropic merge,
	// whose deep clone is load-bearing for the marker moves), so a shallow
	// copy suffices and spares re-copying the full context on every
	// acting-loop call. The merged payload therefore aliases the captured
	// items — sound because pi-ai only serializes the body after onPayload;
	// nothing downstream mutates request items.
	const tailItems = structuredClone(tail) as unknown[];
	stripPromptCacheBreakpoints(tailItems);
	return { ...captured, input: [...captured.input, ...tailItems] };
}
