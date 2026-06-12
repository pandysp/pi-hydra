/**
 * Pure helpers for the hydra observer.
 * Extracted for testability; no pi or I/O dependencies.
 */

export type Action = "noop" | "queue" | "steer" | "interrupt";

export type DeliveryMode = "print" | "queue" | "steer" | "interrupt";

export const DELIVERY_MODES: DeliveryMode[] = ["print", "queue", "steer", "interrupt"];

// A verdict asks for a force level; the delivery mode caps it. The observer
// can always choose less force than the mode allows, never more.
const VERDICT_FORCE: Record<Action, number> = { noop: 0, queue: 1, steer: 2, interrupt: 3 };
const MODE_CAP: Record<DeliveryMode, number> = { print: 0, queue: 1, steer: 2, interrupt: 3 };

/**
 * 0 render only · 1 followUp after the run · 2 steer between turns · 3 abort,
 * then deliver. A verdict formed on a snapshot the driver has since moved past
 * may not abort the current run: interrupt demotes to steer. The asymmetry
 * favors it; a wrong demotion costs one turn of latency, a wrong abort
 * destroys in-flight work.
 */
export function effectiveForce(action: Action, mode: DeliveryMode, staleSnapshot = false): number {
	const force = Math.min(VERDICT_FORCE[action], MODE_CAP[mode]);
	return force === 3 && staleSnapshot ? 2 : force;
}

export interface Decision {
	action: Action;
	reason: string;
	message: string;
}

const ACTIONS: readonly string[] = ["noop", "queue", "steer", "interrupt"];

function asDecision(value: unknown): Decision | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const obj = value as { action?: unknown; reason?: unknown; message?: unknown };
	if (typeof obj.action !== "string" || !ACTIONS.includes(obj.action)) {
		return null;
	}
	return {
		action: obj.action as Action,
		reason: typeof obj.reason === "string" ? obj.reason.slice(0, 200) : "",
		message: typeof obj.message === "string" ? obj.message.slice(0, 500) : "",
	};
}

function tryParseDecision(text: string): Decision | null {
	try {
		return asDecision(JSON.parse(text));
	} catch {
		return null;
	}
}

/** Parse the observer's JSON decision, tolerating code fences and surrounding prose. */
export function parseDecision(text: string): Decision {
	const cleaned = text
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	const direct = tryParseDecision(cleaned);
	if (direct) {
		return direct;
	}

	const embedded = cleaned.match(/\{[^{}]*"action"[^{}]*\}/);
	if (embedded) {
		const parsed = tryParseDecision(embedded[0]);
		if (parsed) {
			return parsed;
		}
	}

	return { action: "noop", reason: "unparseable response", message: "" };
}

export interface ObserverUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Fold the per-iteration usage of one observation (a verdict head makes one
 * call, an acting head one per loop iteration) into stats for a single
 * HydraCall. Totals sum across iterations; the hit ratio comes from the first
 * iteration alone, since that is the replay-parity regression signal and
 * later iterations legitimately pay the loop tail as fresh input.
 */
export function summarizeLoopUsage(usages: ObserverUsage[]): ObserverUsage & { hitRatio: number } {
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

/** Parse a user-supplied lens list ("quality,security" or "quality security"). */
export function parseLensList(value: string): string[] {
	return [...new Set(value.split(/[\s,]+/).map((name) => name.trim()).filter((name) => name.length > 0))];
}

export interface LensDefinition {
	name: string;
	description?: string;
	/** Acting head: may run tool calls before its verdict. Default: verdict-only. */
	tools?: boolean;
	prompt: string;
}

/**
 * Parse a custom lens file: optional `---` frontmatter carrying a description
 * and the `tools: true` acting-head marker, followed by the lens instruction
 * text. Returns null when there is no instruction to observe with.
 */
export function parseLensFile(name: string, content: string): LensDefinition | null {
	let body = content;
	let description: string | undefined;
	let tools: boolean | undefined;
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (frontmatter) {
		body = content.slice(frontmatter[0].length);
		for (const line of frontmatter[1].split("\n")) {
			if (line.startsWith("description:")) {
				description = line.slice("description:".length).trim();
			} else if (line.startsWith("tools:")) {
				tools = line.slice("tools:".length).trim() === "true" || undefined;
			}
		}
	}
	const prompt = body.trim();
	if (prompt.length === 0) {
		return null;
	}
	return { name, description, tools, prompt };
}

export function isValidLensName(name: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

/**
 * Serialize a lens definition to its file form; parseLensFile is the inverse.
 * The description is flattened to one line, since a newline inside it would
 * spill into the frontmatter and corrupt the file.
 */
export function buildLensFile(definition: LensDefinition): string {
	const description = definition.description?.replace(/\s+/g, " ").trim();
	const lines = [
		...(description ? [`description: ${description}`] : []),
		...(definition.tools ? ["tools: true"] : []),
	];
	return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n${definition.prompt}\n` : `${definition.prompt}\n`;
}

export interface LensCatalog {
	exists(name: string): boolean;
	isDiagnostic(name: string): boolean;
}

/**
 * Resolve a requested lens set: drop unknown names, collapse to a single
 * diagnostic when one is present (diagnostics never mix with product lenses;
 * their one-shot revert needs an unambiguous set to restore), dedupe the rest.
 */
export function sanitizeLensSet(requested: string[], catalog: LensCatalog): { lenses: string[]; unknown: string[] } {
	const known = requested.filter((name) => catalog.exists(name));
	const unknown = requested.filter((name) => !catalog.exists(name));
	const diagnostic = known.find((name) => catalog.isDiagnostic(name));
	return { lenses: diagnostic ? [diagnostic] : [...new Set(known)], unknown };
}

/**
 * Normalize a persisted config's lens field: a `lenses` array (an explicit
 * empty array means "no heads" and is respected), the pre-multi-head `lens`
 * string, or null when the entry carries neither.
 */
export function savedLensList(config: { lenses?: unknown; lens?: unknown }): string[] | null {
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
 * and appending it again would duplicate it in the observer's context. Runs
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

function withoutBlockMarkers(message: PayloadMessage): PayloadMessage {
	if (!Array.isArray(message.content)) {
		return message;
	}
	return {
		...message,
		content: message.content.map((block) => {
			if (block.cache_control === undefined) {
				return block;
			}
			const { cache_control: _, ...rest } = block;
			return rest;
		}),
	};
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
 * Merge the observer tail (pi-ai's own serialization of `[M?, prompt,
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
 * - longer: a tool loop appended observer turns. The marker advances to the
 *   tail's last markable block, so each loop turn is written once and read
 *   thereafter instead of re-paid as input every iteration. A plain
 *   ephemeral marker, deliberately without the driver's TTL: loop entries
 *   only need to survive until the next iteration, and the prefix+M entry
 *   the first call wrote keeps serving the driver bet.
 *
 * Markers pi-ai placed on the tail are dropped before any of this.
 */
export function mergeObserverPayload(captured: AnthropicPayload, tail: PayloadMessage[]): AnthropicPayload {
	const merged = structuredClone(captured) as AnthropicPayload;
	// Clone the tail before touching it: it is pi-ai's own params object, and
	// the marker assignment below must not reach back into it.
	const tailMessages = (structuredClone(tail) as PayloadMessage[]).map(withoutBlockMarkers);
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
