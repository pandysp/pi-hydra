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

/** 0 render only · 1 followUp after the run · 2 steer between turns · 3 abort, then deliver. */
export function effectiveForce(action: Action, mode: DeliveryMode): number {
	return Math.min(VERDICT_FORCE[action], MODE_CAP[mode]);
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

/** Parse a user-supplied lens list ("quality,security" or "quality security"). */
export function parseLensList(value: string): string[] {
	return [...new Set(value.split(/[\s,]+/).map((name) => name.trim()).filter((name) => name.length > 0))];
}

export interface LensDefinition {
	name: string;
	description?: string;
	prompt: string;
}

/**
 * Parse a custom lens file: optional `---` frontmatter carrying a description,
 * followed by the lens instruction text. Returns null when there is no
 * instruction to observe with.
 */
export function parseLensFile(name: string, content: string): LensDefinition | null {
	let body = content;
	let description: string | undefined;
	const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n?/);
	if (frontmatter) {
		body = content.slice(frontmatter[0].length);
		const descriptionLine = frontmatter[1].split("\n").find((line) => line.startsWith("description:"));
		if (descriptionLine) {
			description = descriptionLine.slice("description:".length).trim();
		}
	}
	const prompt = body.trim();
	if (prompt.length === 0) {
		return null;
	}
	return { name, description, prompt };
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
	return description ? `---\ndescription: ${description}\n---\n${definition.prompt}\n` : `${definition.prompt}\n`;
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
 * usable assistant message, required to postdate the captured request (it
 * must be that request's own response). Anything older is already serialized
 * inside the captured payload, and appending it again would duplicate it in
 * the observer's context. Runs whose final generation aborted or errored hit
 * exactly that case and select nothing.
 */
export function selectFinalAssistant<T extends FinalAssistantCandidate>(
	messages: T[],
	capturedAtMs: number,
): T | null {
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
		return (message.timestamp ?? 0) >= capturedAtMs ? message : null;
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

// text and tool_use are the marker-eligible block types in an assistant
// message; cache_control on a thinking block is an API error.
function lastMarkableBlock(message: PayloadMessage): PayloadBlock | undefined {
	if (!Array.isArray(message.content)) {
		return undefined;
	}
	for (let i = message.content.length - 1; i >= 0; i--) {
		if (message.content[i].type === "text" || message.content[i].type === "tool_use") {
			return message.content[i];
		}
	}
	return undefined;
}

/**
 * Merge the observer tail (pi-ai's own serialization of `[M?, prompt]`) onto
 * the captured driver payload.
 *
 * The captured prefix is replayed byte-true so the fork reads the driver's
 * cache entry exactly. When the tail carries the run's final assistant
 * message M, the driver's message-level cache marker (TTL included) moves
 * onto M's last markable block: the fork's write then pre-warms the driver's
 * next request, which finds the prefix+M entry via breakpoint walk-back.
 * Markers pi-ai placed on the tail are dropped: the budget is four
 * breakpoints and the observer prompt must stay uncached. Without an
 * eligible target in the tail, the captured markers are left untouched.
 */
export function mergeObserverPayload(captured: AnthropicPayload, tail: PayloadMessage[]): AnthropicPayload {
	const merged = structuredClone(captured) as AnthropicPayload;
	// Clone the tail before touching it: it is pi-ai's own params object, and
	// the marker assignment below must not reach back into it.
	const tailMessages = (structuredClone(tail) as PayloadMessage[]).map(withoutBlockMarkers);
	const assistant = tailMessages.find((message) => message.role === "assistant");
	const target = assistant ? lastMarkableBlock(assistant) : undefined;
	if (target) {
		target.cache_control = stripMessageMarkers(merged.messages) ?? { type: "ephemeral" };
	}
	merged.messages = [...merged.messages, ...tailMessages];
	return merged;
}
