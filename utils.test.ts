import { describe, expect, it } from "vitest";
import type { AnthropicPayload, PayloadBlock, PayloadMessage } from "./utils";
import {
	buildObservationPrompt,
	demoteStaleInterrupt,
	headActs,
	isAnthropicPayload,
	isValidHeadName,
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
		expect(parseDecision('```json\n{"action":"noop","reason":"","message":""}\n```')?.action).toBe("noop");
	});

	it("extracts a decision embedded in prose", () => {
		const text = 'Here is my verdict: {"action":"interrupt","reason":"bad","message":"stop"} — done.';
		expect(parseDecision(text)).toEqual({ action: "interrupt", reason: "bad", message: "stop" });
	});

	it("extracts a decision whose message contains braces", () => {
		const text = 'Decision: {"action":"steer","reason":"r","message":"use {x: 1} not {}"} as discussed.';
		expect(parseDecision(text)?.message).toBe("use {x: 1} not {}");
	});

	it("returns null on garbage and on unknown actions", () => {
		expect(parseDecision("the model rambled instead")).toBeNull();
		expect(parseDecision('{"action":"explode","reason":"r","message":"m"}')).toBeNull();
	});

	it("accepts print", () => {
		expect(parseDecision('{"action":"print","reason":"fyi","message":"note"}')?.action).toBe("print");
	});

	it("records a delivery with nothing to deliver as the noop it is", () => {
		expect(parseDecision('{"action":"interrupt","reason":"bad","message":""}')).toEqual({
			action: "noop",
			reason: "bad (empty message)",
			message: "",
		});
		expect(parseDecision('{"action":"steer","reason":"","message":"   "}')?.action).toBe("noop");
	});

	it("caps reason and message lengths", () => {
		const parsed = parseDecision(
			JSON.stringify({ action: "queue", reason: "r".repeat(300), message: "m".repeat(600) }),
		);
		expect(parsed?.reason).toHaveLength(200);
		expect(parsed?.message).toHaveLength(500);
	});
});

describe("isAnthropicPayload", () => {
	it("accepts an object with a messages array and rejects everything else", () => {
		expect(isAnthropicPayload({ messages: [] })).toBe(true);
		expect(isAnthropicPayload({ messages: [{ role: "user", content: "hi" }], model: "m" })).toBe(true);
		expect(isAnthropicPayload(null)).toBe(false);
		expect(isAnthropicPayload("payload")).toBe(false);
		expect(isAnthropicPayload({ messages: "nope" })).toBe(false);
		expect(isAnthropicPayload({})).toBe(false);
	});
});

describe("rememberDelivery", () => {
	it("dedupes and evicts the oldest key past the cap", () => {
		const seen = new Set<string>();
		expect(rememberDelivery(seen, "a", 2)).toBe(true);
		expect(rememberDelivery(seen, "a", 2)).toBe(false);
		expect(rememberDelivery(seen, "b", 2)).toBe(true);
		expect(rememberDelivery(seen, "c", 2)).toBe(true);
		// "a" was evicted, so it delivers again; "c" is still remembered.
		expect(rememberDelivery(seen, "a", 2)).toBe(true);
		expect(rememberDelivery(seen, "c", 2)).toBe(false);
	});
});

describe("headActs", () => {
	it("acts on undefined (all tools) and on a subset, never on an empty list", () => {
		expect(headActs(undefined)).toBe(true);
		expect(headActs(["read"])).toBe(true);
		expect(headActs([])).toBe(false);
	});
});

describe("buildObservationPrompt", () => {
	it("bans tools for a judge-only head", () => {
		const prompt = buildObservationPrompt("quality", "Judge.", []);
		expect(prompt).toContain("No tools");
		expect(prompt).not.toContain("tool access");
	});

	it("spells out a narrowed allowance", () => {
		const prompt = buildObservationPrompt("docs", "Keep notes.", ["read", "write"]);
		expect(prompt).toContain("only these tools: read, write");
	});

	it("permits everything when tools are omitted", () => {
		expect(buildObservationPrompt("docs", "Keep notes.", undefined)).toContain("the available tools");
	});
});

describe("mergeObservationPayload", () => {
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
		const merged = mergeObservationPayload(capturedFixture(), tail);

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
		const merged = mergeObservationPayload(capturedFixture(), tail);
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
		const merged = mergeObservationPayload(capturedFixture(), tail);
		const assistantBlocks = blocks(merged.messages[2]);
		expect(assistantBlocks[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(assistantBlocks[1].cache_control).toBeUndefined();
	});

	it("leaves captured markers untouched when the tail has no markable assistant", () => {
		const merged = mergeObservationPayload(capturedFixture(), [promptTail()]);

		expect(blocks(merged.messages[1])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(blocks(merged.messages[2])[0].cache_control).toBeUndefined();
	});

	it("leaves captured markers untouched for a thinking-only M", () => {
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "thinking", thinking: "only", signature: "sig" }] },
			promptTail(),
		];
		const merged = mergeObservationPayload(capturedFixture(), tail);
		expect(blocks(merged.messages[1])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
	});

	it("advances the marker to the loop frontier once tool turns are appended, dropping the TTL", () => {
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
			promptTail(),
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "read", input: {}, cache_control: { type: "ephemeral" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [] }] },
		];
		const merged = mergeObservationPayload(capturedFixture(), tail);
		// Loop entries only need to survive until the next iteration: plain
		// ephemeral, not the driver's 1h TTL. The prefix+M entry from the
		// first call keeps serving the driver bet.
		expect(blocks(merged.messages[5])[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks(merged.messages[2])[0].cache_control).toBeUndefined();
		const capturedBlocks = merged.messages.slice(0, 2).flatMap((m) => blocks(m));
		expect(capturedBlocks.every((block) => block.cache_control === undefined)).toBe(true);
	});

	it("advances the marker in a piggyback loop too (no leading M)", () => {
		const tail: PayloadMessage[] = [
			promptTail(),
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [] }] },
		];
		const merged = mergeObservationPayload(capturedFixture(), tail);
		expect(blocks(merged.messages[4])[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks(merged.messages[3]).every((block) => block.cache_control === undefined)).toBe(true);
	});

	it("falls back to a plain ephemeral marker when the captured payload carries none", () => {
		const captured: AnthropicPayload = {
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
		};
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
			promptTail(),
		];
		const merged = mergeObservationPayload(captured, tail);
		expect(blocks(merged.messages[1])[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("never increases the breakpoint count (the budget is four and the driver spends it)", () => {
		const countMarkers = (payload: AnthropicPayload) =>
			payload.messages.flatMap((m) => blocks(m)).filter((block) => block.cache_control !== undefined).length;
		const captured = capturedFixture();
		const loopTail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
			promptTail(),
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [] }] },
		];
		for (const tail of [[promptTail()], [loopTail[0], promptTail()], loopTail]) {
			expect(countMarkers(mergeObservationPayload(captured, tail))).toBeLessThanOrEqual(countMarkers(captured));
		}
	});

	it("mutates neither the captured payload nor the tail", () => {
		const captured = capturedFixture();
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
			promptTail(),
		];
		const capturedBefore = structuredClone(captured);
		const tailBefore = structuredClone(tail);
		mergeObservationPayload(captured, tail);
		expect(captured).toEqual(capturedBefore);
		expect(tail).toEqual(tailBefore);
	});
});

describe("parseHeadFile", () => {
	it("parses a full head file", () => {
		const content = "---\nname: docs\ndescription: Keeps docs current\ntools: read, write\nautostart: true\n---\nKeep docs current.";
		expect(parseHeadFile(content)).toEqual({
			head: {
				name: "docs",
				description: "Keeps docs current",
				tools: ["read", "write"],
				autostart: true,
				prompt: "Keep docs current.",
			},
		});
	});

	it("distinguishes absent tools (all) from empty tools (none)", () => {
		const base = (toolsLine: string) => `---\nname: x\ndescription: d\n${toolsLine}---\nBody.`;
		const head = (content: string) => {
			const parsed = parseHeadFile(content);
			if (!("head" in parsed)) throw new Error("expected a head");
			return parsed.head;
		};
		expect(head(base("")).tools).toBeUndefined();
		expect(head(base("tools: []\n")).tools).toEqual([]);
		expect(head(base("tools:\n")).tools).toEqual([]);
		expect(head(base("tools: read, grep\n")).tools).toEqual(["read", "grep"]);
	});

	it("leaves autostart undefined unless literally true", () => {
		const parsed = parseHeadFile("---\nname: x\ndescription: d\nautostart: false\n---\nBody.");
		expect(parsed).toEqual({ head: { name: "x", description: "d", tools: undefined, autostart: undefined, prompt: "Body." } });
	});

	it("requires frontmatter, name, description, and a body", () => {
		expect(parseHeadFile("Just a body.")).toHaveProperty("error");
		expect(parseHeadFile("---\ndescription: d\n---\nBody.")).toEqual({ error: "missing name:" });
		expect(parseHeadFile("---\nname: x\n---\nBody.")).toEqual({ error: "missing description:" });
		expect(parseHeadFile("---\nname: x\ndescription: d\n---\n  \n")).toEqual({ error: "missing instruction body" });
	});

	it("rejects invalid and reserved names", () => {
		expect(parseHeadFile("---\nname: Docs\ndescription: d\n---\nBody.")).toHaveProperty("error");
		expect(parseHeadFile("---\nname: none\ndescription: d\n---\nBody.")).toHaveProperty("error");
	});

	it("tolerates CRLF line endings and a BOM", () => {
		const crlf = "---\r\nname: x\r\ndescription: d\r\ntools: read\r\n---\r\nBody.\r\n";
		expect(parseHeadFile(`\uFEFF${crlf}`)).toEqual({
			head: { name: "x", description: "d", tools: ["read"], autostart: undefined, prompt: "Body." },
		});
	});

	it("accepts brackets around a tools list", () => {
		const parsed = parseHeadFile("---\nname: x\ndescription: d\ntools: [read, write]\n---\nBody.");
		expect(parsed).toEqual({
			head: { name: "x", description: "d", tools: ["read", "write"], autostart: undefined, prompt: "Body." },
		});
	});

	it("rejects YAML block lists instead of silently parsing an empty value", () => {
		const parsed = parseHeadFile("---\nname: x\ndescription: d\ntools:\n  - read\n  - write\n---\nBody.");
		expect(parsed).toHaveProperty("error");
		expect((parsed as { error: string }).error).toContain("block-style");
	});
});

describe("parseHeadList", () => {
	it("splits on commas and whitespace", () => {
		expect(parseHeadList("quality,security simplifier")).toEqual(["quality", "security", "simplifier"]);
	});

	it("dedupes and drops empties", () => {
		expect(parseHeadList(" quality,, quality ,")).toEqual(["quality"]);
	});

	it("returns empty for blank input", () => {
		expect(parseHeadList("  ")).toEqual([]);
	});
});

describe("demoteStaleInterrupt", () => {
	it("demotes only a stale interrupt, and only to steer", () => {
		expect(demoteStaleInterrupt("interrupt", true)).toBe("steer");
		expect(demoteStaleInterrupt("interrupt", false)).toBe("interrupt");
		expect(demoteStaleInterrupt("steer", true)).toBe("steer");
		expect(demoteStaleInterrupt("queue", true)).toBe("queue");
		expect(demoteStaleInterrupt("print", true)).toBe("print");
		expect(demoteStaleInterrupt("noop", true)).toBe("noop");
	});
});

describe("summarizeLoopUsage", () => {
	const usage = (input: number, cacheRead: number, cacheWrite: number, output = 10, cost = 0.01) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		cost,
	});

	it("sums totals across iterations but takes the hit ratio from the first", () => {
		const summary = summarizeLoopUsage([usage(100, 9900, 0), usage(500, 9900, 0)]);
		expect(summary.input).toBe(600);
		expect(summary.cacheRead).toBe(19800);
		expect(summary.output).toBe(20);
		expect(summary.cost).toBeCloseTo(0.02);
		// First iteration: 9900 / (100 + 9900 + 0), the replay-parity signal.
		expect(summary.hitRatio).toBeCloseTo(99);
	});

	it("matches the single-call case of a verdict head", () => {
		const summary = summarizeLoopUsage([usage(149, 7720, 0)]);
		expect(summary.hitRatio).toBeCloseTo((7720 / 7869) * 100);
	});

	it("returns zeros for an empty loop", () => {
		expect(summarizeLoopUsage([])).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, hitRatio: 0 });
	});

	it("guards the ratio against an all-zero first usage", () => {
		expect(summarizeLoopUsage([usage(0, 0, 0, 0, 0)]).hitRatio).toBe(0);
	});
});

describe("sanitizeHeadSet", () => {
	const catalog = {
		exists: (name: string) => ["quality", "security", "test"].includes(name),
		isDiagnostic: (name: string) => name === "test",
	};

	it("dedupes and splits unknown names", () => {
		expect(sanitizeHeadSet(["quality", "quality", "nope"], catalog)).toEqual({
			heads: ["quality"],
			unknown: ["nope"],
		});
	});

	it("collapses to a single diagnostic when one is present", () => {
		expect(sanitizeHeadSet(["quality", "test", "security"], catalog).heads).toEqual(["test"]);
	});

	it("keeps the first diagnostic when several are requested", () => {
		const twoDiagnostics = {
			exists: () => true,
			isDiagnostic: (name: string) => name.startsWith("test"),
		};
		expect(sanitizeHeadSet(["test-b", "test-a"], twoDiagnostics).heads).toEqual(["test-b"]);
	});

	it("returns empty heads when nothing is known", () => {
		expect(sanitizeHeadSet(["nope"], catalog).heads).toEqual([]);
	});
});

describe("savedHeadList", () => {
	it("prefers the heads array and filters non-strings", () => {
		expect(savedHeadList({ heads: ["a", 1, "b"] })).toEqual(["a", "b"]);
		expect(savedHeadList({ heads: ["a"], lenses: ["old"], lens: "older" })).toEqual(["a"]);
	});

	it("respects an explicit empty array", () => {
		expect(savedHeadList({ heads: [] })).toEqual([]);
	});

	it("reads the pre-rename lenses array and lens string", () => {
		expect(savedHeadList({ lenses: ["quality"] })).toEqual(["quality"]);
		expect(savedHeadList({ lens: "quality" })).toEqual(["quality"]);
	});

	it("returns null when the entry carries none of the fields", () => {
		expect(savedHeadList({})).toBeNull();
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

describe("selectFinalAssistant edge cases", () => {
	it("skips an aborted final response and matches the usable assistant before it", () => {
		const usable = { role: "assistant", content: [{ type: "text" }], timestamp: 100 };
		const aborted = { role: "assistant", stopReason: "aborted", content: [{ type: "text" }], timestamp: 200 };
		// The usable assistant is the captured request's own response.
		expect(selectFinalAssistant([usable, aborted], 100)).toBe(usable);
		// A non-matching survivor means M is already inside the payload.
		expect(selectFinalAssistant([usable, aborted], 999)).toBeNull();
	});

	it("skips string-content assistants", () => {
		const stringContent = { role: "assistant", content: "plain", timestamp: 100 };
		expect(selectFinalAssistant([stringContent], 100)).toBeNull();
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

describe("isValidHeadName", () => {
	it("accepts kebab-case and rejects the rest", () => {
		expect(isValidHeadName("docs-drift")).toBe(true);
		expect(isValidHeadName("a1")).toBe(true);
		expect(isValidHeadName("Docs")).toBe(false);
		expect(isValidHeadName("-x")).toBe(false);
		expect(isValidHeadName("")).toBe(false);
	});

	it("reserves none for the clear-the-set command form", () => {
		expect(isValidHeadName("none")).toBe(false);
	});
});
