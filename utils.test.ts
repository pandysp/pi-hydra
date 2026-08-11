import { describe, expect, it } from "vitest";
import type { AnthropicPayload, OpenAIResponsesPayload, PayloadBlock, PayloadMessage } from "./utils";
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
	demoteStaleInterrupt,
	formatHeadManagementReceipt,
	hasDriverContinuationError,
	headActs,
	isAnthropicPayload,
	isFullInputTransport,
	isOpenAIResponsesPayload,
	isValidHeadName,
	mergeObservationPayload,
	mergeOpenAIObservationPayload,
	parseDecision,
	parseEnumeratedDecision,
	parseHeadFile,
	parseHeadList,
	parseShutdownGrace,
	rememberDelivery,
	sanitizeHeadSet,
	savedHeadList,
	selectFinalAssistant,
	summarizeLoopUsage,
	usesSplitObservationHandoff,
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

describe("decisionFromCompletion", () => {
	it("maps public none to the internal noop without a message", () => {
		expect(decisionFromCompletion("none", "")).toEqual({
			action: "noop",
			reason: "observation completed",
			message: "",
		});
	});

	it("preserves routed deliveries and trims their messages", () => {
		expect(decisionFromCompletion("steer", "  Fix the missing check.  ")).toEqual({
			action: "steer",
			reason: "observation completed",
			message: "Fix the missing check.",
		});
	});

	it("enforces message cardinality instead of repairing malformed calls", () => {
		expect(() => decisionFromCompletion("none", "nothing to report")).toThrow('delivery "none"');
		expect(() => decisionFromCompletion("print", "   ")).toThrow('delivery "print"');
	});
});

describe("formatHeadManagementReceipt", () => {
	it("combines a runtime-owned fact with the head's explanation", () => {
		expect(formatHeadManagementReceipt("add", " security ", "  implementation has started  ")).toBe(
			"Added security — implementation has started",
		);
		expect(formatHeadManagementReceipt("remove", "quality", "the review phase ended")).toBe(
			"Removed quality — the review phase ended",
		);
	});

	it("rejects empty names and explanations", () => {
		expect(() => formatHeadManagementReceipt("add", " ", "needed")).toThrow("non-empty head");
		expect(() => formatHeadManagementReceipt("remove", "quality", " ")).toThrow("non-empty message");
	});
});

describe("applyAfterChangeDelivery", () => {
	const decision = { action: "steer" as const, reason: "updated policy", message: "tell the driver" };

	it("does nothing without a tracked change or a delivery contract", () => {
		expect(applyAfterChangeDelivery(decision, "print", false)).toBe(decision);
		expect(applyAfterChangeDelivery(decision, undefined, true)).toBe(decision);
	});

	it("makes a changed file the complete work product for after-change noop", () => {
		expect(applyAfterChangeDelivery(decision, "noop", true)).toEqual({
			action: "noop",
			reason: "updated policy",
			message: "",
		});
	});

	it("prints after a change and can recover the note from the decision reason", () => {
		expect(applyAfterChangeDelivery({ action: "noop", reason: "added accessibility", message: "" }, "print", true)).toEqual({
			action: "print",
			reason: "added accessibility",
			message: "added accessibility",
		});
	});

	it("preserves a matching print decision", () => {
		const print = { action: "print" as const, reason: "crew changed", message: "Added security." };
		expect(applyAfterChangeDelivery(print, "print", true)).toBe(print);
	});

	it("forces every parsed post-change delivery through a print contract", () => {
		for (const action of ["noop", "queue", "steer", "interrupt"] as const) {
			const decision = { action, reason: "changed", message: action === "noop" ? "" : "finding" };
			expect(applyAfterChangeDelivery(decision, "print", true).action).toBe("print");
		}
	});
});

describe("advanceObservationLoopGuard", () => {
	const initial = { iterations: 0 };

	it("continues an active head and counts the completed turn", () => {
		expect(advanceObservationLoopGuard(initial, { shareLost: false, completed: false, headActive: true, maxIterations: 25 })).toEqual({
			state: { iterations: 1 },
			stopReason: null,
		});
	});

	it("stops at the hard iteration limit", () => {
		expect(
			advanceObservationLoopGuard(
				{ iterations: 24 },
				{ shareLost: false, completed: false, headActive: true, maxIterations: 25 },
			),
		).toMatchObject({ stopReason: "iteration-limit", state: { iterations: 25 } });
	});

	it("stops on an enforceable completion without a grace turn", () => {
		expect(
			advanceObservationLoopGuard(
				{ iterations: 1 },
				{ shareLost: false, completed: true, headActive: true, maxIterations: 25 },
			),
		).toEqual({ state: { iterations: 2 }, stopReason: "completed" });
	});

	it("stops immediately after external deactivation", () => {
		expect(
			advanceObservationLoopGuard(initial, {
				shareLost: false,
				completed: false,
				headActive: false,
				maxIterations: 25,
			}),
		).toMatchObject({ stopReason: "deactivated" });
	});

	it("lets share loss override completion but accepts completion at the hard boundary", () => {
		expect(
			advanceObservationLoopGuard(
				{ iterations: 1 },
				{ shareLost: true, completed: true, headActive: false, maxIterations: 25 },
			).stopReason,
		).toBe("share-loss");
		expect(
			advanceObservationLoopGuard(
				{ iterations: 24 },
				{ shareLost: false, completed: true, headActive: true, maxIterations: 25 },
			).stopReason,
		).toBe("completed");
	});
});

describe("decisionFromLoopStopReason", () => {
	it("turns non-completion wind-downs into quiet terminal decisions", () => {
		expect(decisionFromLoopStopReason("deactivated")).toEqual({
			action: "noop",
			reason: "head deactivated mid-observation",
			message: "",
		});
		expect(decisionFromLoopStopReason("share-loss")?.action).toBe("noop");
		expect(decisionFromLoopStopReason("iteration-limit")?.action).toBe("noop");
	});

	it("leaves normal completion to the accepted tool result", () => {
		expect(decisionFromLoopStopReason("completed")).toBeNull();
		expect(decisionFromLoopStopReason(null)).toBeNull();
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

describe("usesSplitObservationHandoff", () => {
	it("uses the split handoff for Codex Responses and the combined prompt for Anthropic", () => {
		expect(usesSplitObservationHandoff("openai-codex-responses")).toBe(true);
		expect(usesSplitObservationHandoff("anthropic-messages")).toBe(false);
		expect(usesSplitObservationHandoff(undefined)).toBe(false);
	});
});

describe("buildObservationPrompt", () => {
	it("bans tools for a judge-only head", () => {
		const prompt = buildObservationPrompt("quality", "Judge.", []);
		expect(prompt).toContain("no work tools");
		expect(prompt).not.toContain("tool access");
		expect(prompt).toContain('action "complete_observation"');
		expect(prompt).not.toContain("one JSON object");
	});

	it("spells out a narrowed allowance", () => {
		const prompt = buildObservationPrompt("docs", "Keep notes.", ["read", "write"]);
		expect(prompt).toContain("only these tools: read, write");
		expect(prompt).not.toContain("queue");
	});

	it("permits everything when tools are omitted", () => {
		expect(buildObservationPrompt("docs", "Keep notes.", undefined)).toContain("the available tools");
	});

	it("explains a typed print-after-change contract", () => {
		const prompt = buildObservationPrompt("foreman", "Re-crew.", ["hydra"], { afterChange: "print" });
		expect(prompt).toContain('complete with delivery "print"');
		expect(prompt).toContain("manage_heads change prints its own receipt automatically");
		expect(prompt).not.toContain("Noop when your work product is the files you wrote");
	});

	it("includes capability state only for an explicitly Hydra-capable head", () => {
		expect(buildObservationPrompt("crew", "Re-crew.", ["hydra"], { activeHeads: ["quality", "security"] })).toContain(
			"active heads are quality, security",
		);
		expect(buildObservationPrompt("docs", "Write docs.", ["read", "write"], { activeHeads: ["quality"] })).not.toContain(
			"Hydra snapshot",
		);
	});
});

describe("buildAnthropicObservationPrompt", () => {
	it("rejects a judge-only head: the enumerated contract owns that path", () => {
		expect(() => buildAnthropicObservationPrompt("quality", "Judge.", [])).toThrow(
			"enumerated observation contract",
		);
	});

	it("retains acting tools and programmatic management receipts", () => {
		const prompt = buildAnthropicObservationPrompt("foreman", "Re-crew.", ["hydra", "read"], {
			activeHeads: ["foreman", "quality"],
			deliveryContext: {
				lastByThisHead: { delivery: "queue", message: "Old internal delivery." },
				pending: [],
			},
		});
		expect(prompt).toContain("active heads are foreman, quality");
		expect(prompt).toContain("manage_heads change prints its own receipt automatically");
		expect(prompt).toContain("removing your own head completes the observation");
		expect(prompt).not.toContain("queue");
	});
});

describe("buildObservationEnvelope", () => {
	it("keeps the lens out of the elevated judge envelope", () => {
		const envelope = buildObservationEnvelope("quality", []);
		expect(envelope).toContain("preceding user message is the complete quality lens");
		expect(envelope).toContain("lens alone defines scope");
		expect(envelope).toContain("do not broaden it");
		expect(envelope).toContain("no work tools");
		expect(envelope).toContain('action "complete_observation"');
		expect(envelope).not.toContain("one JSON object");
		expect(envelope).not.toContain("LENS:");
		expect(envelope).not.toContain("<system-reminder>");
	});

	it("states each judge delivery meaning once", () => {
		const envelope = buildObservationEnvelope("quality", []);
		for (const delivery of ["print", "queue", "steer", "interrupt"]) {
			expect(envelope.match(new RegExp(`${delivery} is`, "g"))).toHaveLength(1);
		}
	});

	it("preserves a narrowed acting-head allowance", () => {
		expect(buildObservationEnvelope("docs", ["read", "write"])).toContain("only these tools: read, write");
	});

	it("includes typed delivery and capability state without naming a special head", () => {
		const envelope = buildObservationEnvelope("crew", ["hydra", "read"], {
			afterChange: "print",
			activeHeads: ["quality", "security"],
			deliveryContext: {
				lastByThisHead: null,
				pending: [{ head: "crew", delivery: "queue", message: "Old internal delivery." }],
			},
		});
		expect(envelope).toContain('complete with delivery "print"');
		expect(envelope).toContain("manage_heads change prints its own receipt automatically");
		expect(envelope).toContain("active heads are quality, security");
		expect(envelope).not.toContain("queue");
	});

	it("does not expose active state without explicit hydra capability", () => {
		expect(buildObservationEnvelope("docs", ["read", "write"], { activeHeads: ["quality"] })).not.toContain("Hydra snapshot");
		expect(buildObservationEnvelope("unbounded", undefined, { activeHeads: ["quality"] })).not.toContain("Hydra snapshot");
	});
});

describe("enumerated steer-only judge completion", () => {
	const context = {
		lastByThisHead: { delivery: "queue" as const, message: "Fix the redirect." },
		pending: [{ head: "quality", delivery: "queue" as const, message: "Cover the adjacent mutation bug." }],
	};

	it("renders the same ENUM-SO2 contract for split and combined provider handoffs", () => {
		const envelope = buildEnumeratedJudgeObservationEnvelope("security", context);
		const prompt = buildEnumeratedJudgeObservationPrompt("security", "Fix security issues.", context);
		for (const text of [envelope, prompt]) {
			expect(text).toContain(
				'{"findings":[{"action":"print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}',
			);
			expect(text).toContain("List every finding the lens surfaces");
			expect(text).toContain("Do not rank them or pick one");
			expect(text).toContain("Steering is the normal and only way to reach the agent and folds in at its next checkpoint");
			expect(text.toLowerCase()).not.toContain("queue");
		}
		expect(envelope).toContain("preceding user message is the complete security lens");
		expect(envelope).not.toContain("Fix security issues.");
		expect(prompt).toContain("LENS: Fix security issues.");
		expect(prompt).toContain('"recipient":"agent"');
	});

	it("parses an empty findings list as noop", () => {
		expect(parseEnumeratedDecision('{"findings":[]}')).toEqual({
			decisions: [{ action: "noop", reason: "no findings", message: "" }],
			error: null,
		});
	});

	it("separates user-only findings from agent-directed findings", () => {
		expect(
			parseEnumeratedDecision(
				JSON.stringify({
					findings: [
						{ action: "print", reason: "user owns it", message: "Rotate the external credential." },
						{ action: "steer", reason: "current defect", message: "Run the migration before merging." },
					],
				}),
			),
		).toEqual({
			decisions: [
				{
					action: "print",
					reason: "user owns it",
					message: "Rotate the external credential.",
				},
				{
					action: "steer",
					reason: "current defect",
					message: "Run the migration before merging.",
				},
			],
			error: null,
		});
	});

	it("groups agent findings and interrupts only when one of them requests it", () => {
		expect(
			parseEnumeratedDecision(
				JSON.stringify({
					findings: [
						{ action: "steer", reason: "fix", message: "Run the migration." },
						{ action: "interrupt", reason: "emergency", message: "Stop the destructive command." },
						{ action: "steer", reason: "verify", message: "Re-run the checks." },
					],
				}),
			),
		).toEqual({
			decisions: [
				{
					action: "interrupt",
					reason: "fix | emergency | verify",
					message: "Run the migration. | Stop the destructive command. | Re-run the checks.",
				},
			],
			error: null,
		});
	});

	it("accepts a fenced object but rejects hidden queue and malformed findings", () => {
		expect(parseEnumeratedDecision('```json\n{"findings":[]}\n```').decisions?.[0]?.action).toBe("noop");
		expect(
			parseEnumeratedDecision('{"findings":[{"action":"queue","reason":"later","message":"Do it later."}]}'),
		).toMatchObject({ decisions: null, error: 'finding 1 has invalid action "queue"' });
		expect(parseEnumeratedDecision('{"findings":[{"action":"steer","reason":"missing message"}]}')).toMatchObject({
			decisions: null,
			error: "finding 1 requires a non-empty message",
		});
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

		// The driver's cache mark moved rather than being copied...
		const capturedBlocks = merged.messages.slice(0, 2).flatMap((m) => blocks(m));
		expect(capturedBlocks.every((block) => block.cache_control === undefined)).toBe(true);
		// ...the instruction stays unmarked, and the limit of four is respected.
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
		// Loop entries only need to last until the next iteration, so they get
		// the short-lived mark rather than the driver's hour-long one. What the
		// first call stored is what keeps serving the driver.
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

	it("inserts a system envelope immediately after the lens without changing marker semantics", () => {
		const tail: PayloadMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "final" }] },
			promptTail(),
		];
		const merged = mergeObservationPayload(capturedFixture(), tail, "protocol");
		expect(merged.messages.slice(2).map((message) => message.role)).toEqual(["assistant", "user", "system"]);
		expect(blocks(merged.messages[4])[0]).toEqual({ type: "text", text: "protocol" });
		// A separately sent set of rules must not be mistaken for a loop turn.
		// The agent's final message still gets the driver's long-lived mark and
		// the rules themselves stay uncached.
		expect(blocks(merged.messages[2])[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(blocks(merged.messages[4])[0].cache_control).toBeUndefined();
	});

	it("keeps the system envelope adjacent to the lens across acting-loop turns", () => {
		const tail: PayloadMessage[] = [
			promptTail(),
			{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [] }] },
		];
		const merged = mergeObservationPayload(capturedFixture(), tail, "protocol");
		expect(merged.messages.slice(2).map((message) => message.role)).toEqual(["user", "system", "assistant", "user"]);
		expect(blocks(merged.messages[5])[0].cache_control).toEqual({ type: "ephemeral" });
		expect(blocks(merged.messages[3])[0].cache_control).toBeUndefined();
	});

	it("rejects a split handoff without a lens user message", () => {
		expect(() =>
			mergeObservationPayload(capturedFixture(), [{ role: "assistant", content: [{ type: "text", text: "M" }] }], "protocol"),
		).toThrow("tail has no user prompt");
	});
});

describe("isFullInputTransport", () => {
	it("admits exactly the transports without delta continuation", () => {
		expect(isFullInputTransport("websocket")).toBe(true);
		expect(isFullInputTransport("sse")).toBe(true);
		expect(isFullInputTransport("auto")).toBe(false);
		expect(isFullInputTransport("websocket-cached")).toBe(false);
		expect(isFullInputTransport("")).toBe(false);
		expect(isFullInputTransport("WEBSOCKET")).toBe(false);
	});
});

describe("classifyCodexShareLoss", () => {
	it("clears full-input transports and names everything else", () => {
		expect(classifyCodexShareLoss("websocket")).toBeNull();
		expect(classifyCodexShareLoss("sse")).toBeNull();
		expect(classifyCodexShareLoss("auto")).toContain('pi transport "auto"');
		expect(classifyCodexShareLoss("websocket-cached")).toContain("delta continuation");
		expect(classifyCodexShareLoss("")).not.toBeNull();
	});
});

describe("hasDriverContinuationError", () => {
	const errored = (errorMessage: string) => ({ role: "assistant", stopReason: "error", errorMessage });

	it("matches the measured signature and wording variants", () => {
		expect(hasDriverContinuationError([errored("Codex error: Previous response with id 'resp_02e6a5' not found.")])).toBe(true);
		expect(hasDriverContinuationError([errored("previous_response_id resp_1 was not found")])).toBe(true);
		expect(hasDriverContinuationError([errored("The previous response could not be found")])).toBe(true);
		expect(hasDriverContinuationError([errored("Previous response with id 'resp_1'\nwas not\nfound")])).toBe(true);
	});

	it("requires an errored assistant message, not just the words", () => {
		expect(hasDriverContinuationError([{ role: "assistant", stopReason: "stop", errorMessage: "previous response not found" }])).toBe(false);
		expect(hasDriverContinuationError([{ role: "user", stopReason: "error", errorMessage: "previous response not found" }])).toBe(false);
		expect(hasDriverContinuationError([errored("rate limit exceeded")])).toBe(false);
		expect(hasDriverContinuationError([{ role: "assistant", stopReason: "error" }])).toBe(false);
		expect(hasDriverContinuationError([])).toBe(false);
	});
});

describe("isOpenAIResponsesPayload", () => {
	it("accepts an object with an input array and rejects everything else", () => {
		expect(isOpenAIResponsesPayload({ input: [] })).toBe(true);
		expect(isOpenAIResponsesPayload({ input: [{ type: "message" }], model: "gpt-5.6-luna" })).toBe(true);
		expect(isOpenAIResponsesPayload({ messages: [] })).toBe(false);
		expect(isOpenAIResponsesPayload({ input: "not an array" })).toBe(false);
		expect(isOpenAIResponsesPayload(null)).toBe(false);
		expect(isOpenAIResponsesPayload("input")).toBe(false);
	});
});

describe("mergeOpenAIObservationPayload", () => {
	const capturedFixture = (): OpenAIResponsesPayload => ({
		model: "gpt-5.6-luna",
		store: false,
		stream: true,
		instructions: "You are pi.",
		prompt_cache_key: "session-abc",
		include: ["reasoning.encrypted_content"],
		input: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
			{ type: "function_call", name: "read", call_id: "call_1", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "file contents" },
		],
		tools: [{ type: "function", name: "read" }],
	});

	const promptTail = () => ({
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "observe this" }],
	});

	it("appends the tail and replays every other captured field byte-true", () => {
		const captured = capturedFixture();
		const tail = [promptTail()];
		const merged = mergeOpenAIObservationPayload(captured, tail);

		expect(merged.input).toEqual([...captured.input, promptTail()]);
		const { input: _mergedInput, ...mergedRest } = merged;
		const { input: _capturedInput, ...capturedRest } = capturedFixture();
		expect(mergedRest).toEqual(capturedRest);
	});

	it("carries a run-end M through as pi-ai serialized it, reasoning items included", () => {
		const tail = [
			{ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
			{ type: "message", role: "assistant", id: "msg_1", content: [{ type: "output_text", text: "done" }] },
			promptTail(),
		];
		const merged = mergeOpenAIObservationPayload(capturedFixture(), tail);
		expect(merged.input.slice(3)).toEqual(structuredClone(tail));
	});

	it("strips explicit cache breakpoints from the tail (hydra owns marker placement)", () => {
		const tail = [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "observe this", prompt_cache_breakpoint: { mode: "explicit" } },
					{ type: "input_text", text: "and this" },
				],
			},
		];
		const merged = mergeOpenAIObservationPayload(capturedFixture(), tail);
		expect(merged.input[3]).toEqual({
			type: "message",
			role: "user",
			content: [
				{ type: "input_text", text: "observe this" },
				{ type: "input_text", text: "and this" },
			],
		});
	});

	it("leaves breakpoints in the captured prefix untouched (the driver's markers are the driver's)", () => {
		const captured = capturedFixture();
		const first = captured.input[0] as { content: Array<Record<string, unknown>> };
		first.content[0].prompt_cache_breakpoint = { mode: "explicit" };
		const merged = mergeOpenAIObservationPayload(captured, [promptTail()]);
		// Compare what the mark says, not whether it is the same object. The
		// merge is allowed to share objects, and a shared one would pass this
		// check no matter what the code did.
		const mergedFirst = merged.input[0] as { content: Array<Record<string, unknown>> };
		expect(mergedFirst.content[0].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
		expect(mergedFirst.content[0].text).toBe("hi");
	});

	it("tolerates tail items without block content", () => {
		const tail = [
			{ type: "function_call", name: "read", call_id: "call_2", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_2", output: "ok" },
			null,
			{ type: "message", role: "user", content: "plain string content" },
		];
		const merged = mergeOpenAIObservationPayload(capturedFixture(), tail);
		expect(merged.input.slice(3)).toEqual(structuredClone(tail));
	});

	it("mutates neither the captured payload nor the tail", () => {
		const captured = capturedFixture();
		// Put a mark in the captured part on purpose, so that code stripping
		// marks too broadly is caught here rather than in production.
		(captured.input[0] as { content: Array<Record<string, unknown>> }).content[0].prompt_cache_breakpoint = { mode: "explicit" };
		const tail = [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "observe", prompt_cache_breakpoint: { mode: "explicit" } }],
			},
		];
		const capturedBefore = structuredClone(captured);
		const tailBefore = structuredClone(tail);
		mergeOpenAIObservationPayload(captured, tail);
		expect(captured).toEqual(capturedBefore);
		expect(tail).toEqual(tailBefore);
	});

	it("inserts a developer envelope immediately after the lens, after run-end reasoning items", () => {
		const tail = [
			{ type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
			promptTail(),
		];
		const merged = mergeOpenAIObservationPayload(capturedFixture(), tail, "protocol");
		expect(merged.input.slice(3).map((item) => (item as { role?: string }).role ?? (item as { type?: string }).type)).toEqual([
			"reasoning",
			"assistant",
			"user",
			"developer",
		]);
		expect(merged.input[6]).toEqual({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: "protocol" }],
		});
	});

	it("keeps the developer envelope adjacent to the lens across acting-loop items", () => {
		const tail = [
			promptTail(),
			{ type: "function_call", name: "read", call_id: "call_2", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_2", output: "ok" },
		];
		const merged = mergeOpenAIObservationPayload(capturedFixture(), tail, "protocol");
		expect(merged.input.slice(3).map((item) => (item as { role?: string }).role ?? (item as { type?: string }).type)).toEqual([
			"user",
			"developer",
			"function_call",
			"function_call_output",
		]);
	});

	it("rejects a split handoff without a lens user message", () => {
		expect(() => mergeOpenAIObservationPayload(capturedFixture(), [{ type: "reasoning" }], "protocol")).toThrow(
			"tail has no user prompt",
		);
	});
});

describe("parseHeadFile", () => {
	it("parses a full head file", () => {
		const content = "---\nname: docs\ndescription: Keeps docs current\ntools: read, write\nautostart: true\nafter-change: noop\n---\nKeep docs current.";
		expect(parseHeadFile(content)).toEqual({
			head: {
				name: "docs",
				description: "Keeps docs current",
				tools: ["read", "write"],
				autostart: true,
				afterChange: "noop",
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
		expect(parsed).toEqual({
			head: { name: "x", description: "d", tools: undefined, autostart: undefined, afterChange: undefined, prompt: "Body." },
		});
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
			head: { name: "x", description: "d", tools: ["read"], autostart: undefined, afterChange: undefined, prompt: "Body." },
		});
	});

	it("accepts brackets around a tools list", () => {
		const parsed = parseHeadFile("---\nname: x\ndescription: d\ntools: [read, write]\n---\nBody.");
		expect(parsed).toEqual({
			head: {
				name: "x",
				description: "d",
				tools: ["read", "write"],
				autostart: undefined,
				afterChange: undefined,
				prompt: "Body.",
			},
		});
	});

	it("rejects invalid delivery metadata and delivery on a judge-only head", () => {
		expect(parseHeadFile("---\nname: x\ndescription: d\ntools: read\nafter-change: queue\n---\nBody.")).toEqual({
			error: 'invalid after-change "queue" (expected: noop, print)',
		});
		expect(parseHeadFile("---\nname: x\ndescription: d\ntools: []\nafter-change: noop\n---\nBody.")).toEqual({
			error: "after-change requires an acting head (tools must not be [])",
		});
		expect(parseHeadFile("---\nname: x\ndescription: d\ntools: read\nafter-change: print\n---\nBody.")).toEqual({
			error: "after-change requires write, edit, or omitted tools",
		});
		expect(parseHeadFile("---\nname: x\ndescription: d\ntools: hydra\nafter-change: print\n---\nBody.")).toEqual({
			error: "after-change requires write, edit, or omitted tools",
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
		// From the first call only: 9900 / (100 + 9900 + 0).
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
		// This once dropped the agent's final message whenever it happened to be
		// built in the millisecond before the request went out. Comparing clock
		// times instead of matching the reply is what caused it.
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
