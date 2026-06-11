import { describe, expect, it } from "vitest";
import type { AnthropicPayload, PayloadBlock, PayloadMessage } from "./utils";
import {
	buildLensFile,
	DELIVERY_MODES,
	effectiveForce,
	isValidLensName,
	mergeObserverPayload,
	parseDecision,
	parseLensFile,
	parseLensList,
	parseShutdownGrace,
	sanitizeLensSet,
	savedLensList,
	selectFinalAssistant,
} from "./utils";

function blocks(message: PayloadMessage): PayloadBlock[] {
	if (!Array.isArray(message.content)) {
		throw new Error("expected block content");
	}
	return message.content;
}

describe("parseDecision", () => {
	it("parses a plain JSON decision", () => {
		expect(parseDecision('{"action":"queue","reason":"r","message":"m"}')).toEqual({
			action: "queue",
			reason: "r",
			message: "m",
		});
	});

	it("strips markdown fences", () => {
		expect(parseDecision('```json\n{"action":"noop","reason":"","message":""}\n```').action).toBe("noop");
	});

	it("extracts a decision embedded in prose", () => {
		const text = 'Here is my verdict: {"action":"interrupt","reason":"bad","message":"stop"} — done.';
		expect(parseDecision(text)).toEqual({ action: "interrupt", reason: "bad", message: "stop" });
	});

	it("falls back to noop on garbage", () => {
		expect(parseDecision("the model rambled instead")).toEqual({
			action: "noop",
			reason: "unparseable response",
			message: "",
		});
	});

	it("rejects unknown actions", () => {
		expect(parseDecision('{"action":"explode","reason":"r","message":"m"}').action).toBe("noop");
	});

	it("caps reason and message lengths", () => {
		const parsed = parseDecision(
			JSON.stringify({ action: "queue", reason: "r".repeat(300), message: "m".repeat(600) }),
		);
		expect(parsed.reason).toHaveLength(200);
		expect(parsed.message).toHaveLength(500);
	});
});

describe("mergeObserverPayload", () => {
	const capturedFixture = (): AnthropicPayload => ({
		model: "claude-test",
		system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "user",
				content: [{ type: "text", text: "again", cache_control: { type: "ephemeral", ttl: "1h" } }],
			},
		],
	});

	const promptTail = (): PayloadMessage => ({
		role: "user",
		content: [{ type: "text", text: "observe this", cache_control: { type: "ephemeral" } }],
	});

	it("moves the driver marker onto M's last text block, TTL preserved", () => {
		const tail: PayloadMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hmm", signature: "sig" },
					{ type: "text", text: "final answer" },
				],
			},
			promptTail(),
		];
		const merged = mergeObserverPayload(capturedFixture(), tail);

		expect(blocks(merged.messages[2])[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		// The driver's message-level marker moved (not duplicated)...
		const capturedBlocks = merged.messages.slice(0, 2).flatMap((m) => blocks(m));
		expect(capturedBlocks.every((block) => block.cache_control === undefined)).toBe(true);
		// ...the prompt stays unmarked, and the four-breakpoint budget holds.
		expect(blocks(merged.messages[3])[0].cache_control).toBeUndefined();
	});

	it("marks a trailing tool_use block when M ends with one", () => {
		const tail: PayloadMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "calling a tool" },
					{ type: "tool_use", id: "t1", name: "read", input: {} },
				],
			},
			promptTail(),
		];
		const merged = mergeObserverPayload(capturedFixture(), tail);
		const assistantBlocks = blocks(merged.messages[2]);
		expect(assistantBlocks[0].cache_control).toBeUndefined();
		expect(assistantBlocks[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("never touches a thinking block, even when it is M's last block", () => {
		const tail: PayloadMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "partial" },
					{ type: "thinking", thinking: "trailing", signature: "sig" },
				],
			},
			promptTail(),
		];
		const merged = mergeObserverPayload(capturedFixture(), tail);
		const assistantBlocks = blocks(merged.messages[2]);
		expect(assistantBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(assistantBlocks[1].cache_control).toBeUndefined();
	});

	it("leaves captured markers untouched when the tail has no markable assistant", () => {
		const merged = mergeObserverPayload(capturedFixture(), [promptTail()]);

		expect(blocks(merged.messages[1])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(blocks(merged.messages[2])[0].cache_control).toBeUndefined();
	});

	it("leaves captured markers untouched for a thinking-only M", () => {
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "only", signature: "sig" }] },
			promptTail(),
		];
		const merged = mergeObserverPayload(capturedFixture(), tail);
		expect(blocks(merged.messages[1])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("mutates neither the captured payload nor the tail", () => {
		const captured = capturedFixture();
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
			promptTail(),
		];
		const capturedBefore = structuredClone(captured);
		const tailBefore = structuredClone(tail);
		mergeObserverPayload(captured, tail);
		expect(captured).toEqual(capturedBefore);
		expect(tail).toEqual(tailBefore);
	});
});

describe("parseLensFile", () => {
	it("parses a plain body", () => {
		expect(parseLensFile("brevity", "Review for verbosity.\n")).toEqual({
			name: "brevity",
			description: undefined,
			prompt: "Review for verbosity.",
		});
	});

	it("parses frontmatter with a description", () => {
		const content = "---\ndescription: Flags wordy output\n---\nReview for verbosity.";
		expect(parseLensFile("brevity", content)).toEqual({
			name: "brevity",
			description: "Flags wordy output",
			prompt: "Review for verbosity.",
		});
	});

	it("ignores frontmatter without a description", () => {
		expect(parseLensFile("x", "---\nauthor: me\n---\nBody.")).toEqual({
			name: "x",
			description: undefined,
			prompt: "Body.",
		});
	});

	it("returns null when there is no instruction", () => {
		expect(parseLensFile("empty", "   \n")).toBeNull();
		expect(parseLensFile("only-frontmatter", "---\ndescription: d\n---\n\n")).toBeNull();
	});
});

describe("parseLensList", () => {
	it("splits on commas and whitespace", () => {
		expect(parseLensList("quality,security simplifier")).toEqual(["quality", "security", "simplifier"]);
	});

	it("dedupes and drops empties", () => {
		expect(parseLensList(" quality,, quality ,")).toEqual(["quality"]);
	});

	it("returns empty for blank input", () => {
		expect(parseLensList("  ")).toEqual([]);
	});
});

describe("effectiveForce", () => {
	it("caps verdict force at the delivery mode, full matrix", () => {
		const expected: Record<string, Record<string, number>> = {
			print: { noop: 0, queue: 0, steer: 0, interrupt: 0 },
			queue: { noop: 0, queue: 1, steer: 1, interrupt: 1 },
			steer: { noop: 0, queue: 1, steer: 2, interrupt: 2 },
			interrupt: { noop: 0, queue: 1, steer: 2, interrupt: 3 },
		};
		for (const mode of DELIVERY_MODES) {
			for (const action of ["noop", "queue", "steer", "interrupt"] as const) {
				expect(effectiveForce(action, mode), `${action} in ${mode}`).toBe(expected[mode][action]);
			}
		}
	});
});

describe("sanitizeLensSet", () => {
	const catalog = {
		exists: (name: string) => ["quality", "security", "test"].includes(name),
		isDiagnostic: (name: string) => name === "test",
	};

	it("dedupes and splits unknown names", () => {
		expect(sanitizeLensSet(["quality", "quality", "nope"], catalog)).toEqual({
			lenses: ["quality"],
			unknown: ["nope"],
		});
	});

	it("collapses to a single diagnostic when one is present", () => {
		expect(sanitizeLensSet(["quality", "test", "security"], catalog).lenses).toEqual(["test"]);
	});

	it("returns empty lenses when nothing is known", () => {
		expect(sanitizeLensSet(["nope"], catalog).lenses).toEqual([]);
	});
});

describe("savedLensList", () => {
	it("prefers the lenses array and filters non-strings", () => {
		expect(savedLensList({ lenses: ["a", 1, "b"] })).toEqual(["a", "b"]);
	});

	it("respects an explicit empty array", () => {
		expect(savedLensList({ lenses: [] })).toEqual([]);
	});

	it("reads the pre-multi-head lens string", () => {
		expect(savedLensList({ lens: "quality" })).toEqual(["quality"]);
	});

	it("returns null when the entry carries neither", () => {
		expect(savedLensList({})).toBeNull();
	});
});

describe("selectFinalAssistant", () => {
	const asst = (timestamp: number, stopReason = "stop", content: unknown = [{ type: "text", text: "x" }]) => ({
		role: "assistant",
		stopReason,
		content,
		timestamp,
	});
	const RESPONSE_TS = 1500;

	it("returns the final assistant message when it is the captured request's response", () => {
		const m = asst(RESPONSE_TS);
		expect(selectFinalAssistant([asst(500), { role: "user" }, m], RESPONSE_TS)).toBe(m);
	});

	it("matches by identity, not clock order: pi stamps M ~1ms before the capture hook fires", () => {
		// Regression: a >= capturedAtMs comparison silently dropped M whenever
		// the message construction landed in the millisecond before the hook.
		const m = asst(RESPONSE_TS);
		expect(selectFinalAssistant([m], RESPONSE_TS)).toBe(m);
		expect(selectFinalAssistant([m], RESPONSE_TS + 1)).toBeNull();
	});

	it("returns null when the captured request never started a response", () => {
		expect(selectFinalAssistant([asst(500)], null)).toBeNull();
	});

	it("returns null when the final generation aborted (older M is already in the payload)", () => {
		expect(selectFinalAssistant([asst(500), asst(RESPONSE_TS, "aborted")], RESPONSE_TS)).toBeNull();
	});

	it("returns null when the final generation errored", () => {
		expect(selectFinalAssistant([asst(500), asst(RESPONSE_TS, "error")], RESPONSE_TS)).toBeNull();
	});

	it("skips trailing non-assistant messages", () => {
		const m = asst(RESPONSE_TS, "toolUse");
		expect(selectFinalAssistant([m, { role: "toolResult" }], RESPONSE_TS)).toBe(m);
	});

	it("rejects empty content and messages with errorMessage", () => {
		expect(selectFinalAssistant([asst(RESPONSE_TS, "stop", [])], RESPONSE_TS)).toBeNull();
		expect(selectFinalAssistant([{ ...asst(RESPONSE_TS), errorMessage: "boom" }], RESPONSE_TS)).toBeNull();
	});

	it("returns null for an empty run", () => {
		expect(selectFinalAssistant([], RESPONSE_TS)).toBeNull();
	});
});

describe("parseShutdownGrace", () => {
	it("accepts zero as do-not-wait and plain numbers", () => {
		expect(parseShutdownGrace("0", 5000)).toBe(0);
		expect(parseShutdownGrace("120000", 5000)).toBe(120000);
	});

	it("falls back on unset, blank, negative, and garbage", () => {
		expect(parseShutdownGrace(undefined, 5000)).toBe(5000);
		expect(parseShutdownGrace("  ", 5000)).toBe(5000);
		expect(parseShutdownGrace("-5", 5000)).toBe(5000);
		expect(parseShutdownGrace("abc", 5000)).toBe(5000);
	});
});

describe("isValidLensName", () => {
	it("accepts kebab-case and rejects the rest", () => {
		expect(isValidLensName("docs-drift")).toBe(true);
		expect(isValidLensName("a1")).toBe(true);
		expect(isValidLensName("Docs")).toBe(false);
		expect(isValidLensName("-x")).toBe(false);
		expect(isValidLensName("")).toBe(false);
	});
});

describe("buildLensFile", () => {
	it("round-trips through parseLensFile", () => {
		const definition = { name: "brevity", description: "Flags wordy output", prompt: "Review for verbosity." };
		expect(parseLensFile("brevity", buildLensFile(definition))).toEqual(definition);
	});

	it("round-trips without a description", () => {
		expect(parseLensFile("x", buildLensFile({ name: "x", prompt: "Body." }))).toEqual({
			name: "x",
			description: undefined,
			prompt: "Body.",
		});
	});

	it("flattens newlines in the description so frontmatter cannot be corrupted", () => {
		const built = buildLensFile({ name: "x", description: "line one\nline two", prompt: "Body." });
		expect(parseLensFile("x", built)).toEqual({ name: "x", description: "line one line two", prompt: "Body." });
	});
});
