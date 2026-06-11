/**
 * Pure helpers for the hydra observer.
 * Extracted for testability; no pi or I/O dependencies.
 */

export type Action = "noop" | "queue" | "interrupt";

export interface Decision {
	action: Action;
	reason: string;
	message: string;
}

const ACTIONS: readonly string[] = ["noop", "queue", "interrupt"];

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
