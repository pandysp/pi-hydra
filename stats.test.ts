import { describe, expect, it } from "vitest";
import { HIT_BANDS, hitBandsFor, parseBranchEntries, StatsLog } from "./stats";
import type { BranchEntryLike, HydraCall } from "./stats";

function call(over: Partial<HydraCall>): HydraCall {
	return {
		timestamp: 1,
		turnIndex: 0,
		head: "quality",
		action: "noop",
		input: 100,
		output: 10,
		cacheRead: 900,
		cacheWrite: 0,
		cost: 0.01,
		durationMs: 5,
		hitRatio: 90,
		...over,
	};
}

const entry = (customType: string, data: unknown): BranchEntryLike => ({ type: "custom", customType, data });

describe("stats store", () => {
	it("totals money session-wide but averages hit ratio only over comparable calls", () => {
		const stats = new StatsLog();
		stats.record(call({ api: "anthropic-messages", cacheRead: 900, cacheWrite: 100, input: 0, cost: 0.01 }));
		stats.record(call({ api: "openai-codex-responses", cacheRead: 0, cacheWrite: 0, input: 1000, cost: 0.05 }));
		const cumulative = stats.cumulative("anthropic-messages");
		expect(cumulative.cost).toBeCloseTo(0.06);
		expect(cumulative.input).toBe(1000);
		expect(cumulative.meanHit).toBeCloseTo(90);
	});

	it("reports a null mean hit when no call is comparable, not a total miss", () => {
		const stats = new StatsLog();
		stats.record(call({ api: "anthropic-messages" }));
		expect(stats.cumulative("openai-codex-responses").meanHit).toBeNull();
	});

	it("treats entries recorded before the api field as Anthropic history", () => {
		const stats = new StatsLog();
		stats.record(call({ api: undefined, cacheRead: 500, cacheWrite: 0, input: 500 }));
		expect(stats.cumulative("anthropic-messages").meanHit).toBeCloseTo(50);
		expect(stats.cumulative("openai-codex-responses").meanHit).toBeNull();
	});

	it("replaces its log on load, the branch-navigation contract", () => {
		const stats = new StatsLog();
		stats.record(call({ head: "before" }));
		stats.load([call({ head: "restored" })]);
		expect(stats.count).toBe(1);
		expect(stats.all()[0].head).toBe("restored");
	});
});

describe("hit bands", () => {
	it("selects the codex band only for the codex responses api", () => {
		expect(hitBandsFor("openai-codex-responses")).toBe(HIT_BANDS.codex);
		expect(hitBandsFor("anthropic-messages")).toBe(HIT_BANDS.default);
		expect(hitBandsFor(undefined)).toBe(HIT_BANDS.default);
	});
});

describe("parseBranchEntries", () => {
	it("rebuilds calls with the pre-rename lens fallback and skips non-custom entries", () => {
		const { calls } = parseBranchEntries([
			{ type: "message" },
			entry("hydra-call", { ...call({}), head: undefined, lens: "old-name" }),
			entry("hydra-call", call({ head: "quality" })),
			entry("hydra-call", null),
		]);
		expect(calls.map((c) => c.head)).toEqual(["old-name", "quality"]);
	});

	it("keeps the last config and distinguishes absent from deliberately empty", () => {
		expect(parseBranchEntries([]).config).toBeUndefined();
		const { config } = parseBranchEntries([
			entry("hydra-config", { heads: ["quality"] }),
			entry("hydra-config", { heads: [] }),
		]);
		expect(config).toEqual({ heads: [] });
	});

	it("keeps valid delivery receipts and drops malformed ones", () => {
		const valid = { head: "quality", delivery: "steer", message: "m", timestamp: 7 };
		const { deliveries } = parseBranchEntries([
			entry("hydra-delivery", valid),
			entry("hydra-delivery", { ...valid, delivery: "abort" }),
			entry("hydra-delivery", { ...valid, message: "" }),
			entry("hydra-delivery", { ...valid, timestamp: Number.NaN }),
			entry("hydra-delivery", "not an object"),
		]);
		expect(deliveries).toEqual([valid]);
	});
});
