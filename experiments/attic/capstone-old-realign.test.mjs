import { describe, expect, it } from "vitest";
import { realignOldInput } from "./capstone-old-realign.mjs";

describe("old-input eligibility realignment (ITERATION1-DATA-PASS A4)", () => {
	const result = realignOldInput();

	it("reproduces both registered twelves as distinct sets", () => {
		expect(result.counts).toMatchObject({
			strict: 119,
			semantic: 131,
			packetJudged: 107,
			missingFromPacket: 12,
			cacheOnlyDelta: 12,
		});
		const missing = new Set(result.missingFromPacket.map((item) => item.sourceKey));
		const cacheOnly = new Set(result.cacheOnlyDelta.map((item) => item.sourceKey));
		for (const key of missing) expect(cacheOnly.has(key)).toBe(false);
	});

	it("locates every packet-missing finding at a cell's final run-end point", () => {
		for (const item of result.missingFromPacket) {
			expect(["scheduler/sol-high/a1/r3/19", "scheduler/sol-xhigh/a1/r3/18"]).toContain(item.pointId);
		}
	});

	it("confirms the missing findings are exactly the recorded unjudgeables, not new work", () => {
		expect(result.missingAllRecordedUnjudgeable).toBe(true);
	});

	it("stages a cache-only re-judging delta that contains no F2 findings", () => {
		expect(result.cacheOnlyDelta.every((item) => item.arm !== "F2")).toBe(true);
	});
});
