import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { anchorLiveAtPoint, oneJudgeFloor, packetSupport, parseKey, rowKeyOf } from "./capstone-score.mjs";

describe("anchor liveness under anchor state (A2)", () => {
	const files = { "src/scheduler.js": "export async function claimNext(store) {}" };

	it("answers unknown for a foreign-frame end-state anchor instead of never-live", () => {
		const issue = { anchors: { file: "src/scheduler.js", expression: "not in this run", match: "literal", state: "end" } };
		expect(anchorLiveAtPoint(files, issue)).toBe("unknown");
	});

	it("still resolves seed-frame anchors against the snapshots", () => {
		const live = { anchors: { file: "src/scheduler.js", expression: "claimNext", match: "literal", state: "seed" } };
		const fixed = { anchors: { file: "src/scheduler.js", expression: "not present", match: "literal", state: "seed" } };
		expect(anchorLiveAtPoint(files, live)).toBe("live");
		expect(anchorLiveAtPoint(files, fixed)).toBe("fixed");
	});
});

describe("packet support and the one-judge floor (A3, A7)", () => {
	const packet = {
		findings: [
			{
				sourceKey: "r/scheduler/sol-high/a1/r0/1/MAIN-SO2/f0",
				qualitySourceValidity: "cache-only-invalid",
				solClaims: [{ centralSupported: false, matches: [{ issueId: "SCHED-x" }] }],
				opusClaims: [],
			},
			{
				sourceKey: "r/scheduler/sol-high/a1/r0/2/MAIN-SO2/f0",
				qualitySourceValidity: "valid",
				solClaims: [{ centralSupported: true, matches: [{ issueId: "SCHED-a" }] }],
				opusClaims: [{ centralSupported: true, matches: [{ issueId: "SCHED-b" }] }],
			},
		],
	};

	it("reads judged-real from claim support, not claim presence", () => {
		const support = packetSupport(packet);
		const first = support.get("r/scheduler/sol-high/a1/r0/1/MAIN-SO2/f0");
		expect(first.sol.supported).toBe(false);
		expect(first.sol.matched.size).toBe(0); // refuted claims cannot carry matches into the floor
		const second = support.get("r/scheduler/sol-high/a1/r0/2/MAIN-SO2/f0");
		expect(second.sol.supported).toBe(true);
		expect(second.validity).toBe("valid");
	});

	it("counts active ids matched by exactly one judge, with the blocking subcount", () => {
		const activeById = new Map([
			["SCHED-a", { tier: "blocking" }],
			["SCHED-b", { tier: "harmful" }],
		]);
		const entries = [...packetSupport(packet).values()];
		const floor = oneJudgeFloor(entries, activeById);
		expect(floor.ids).toEqual(["SCHED-a", "SCHED-b"]);
		expect(floor.blocking).toBe(1);
	});
});

describe("key parsing", () => {
	it("splits source keys and strips finding suffixes", () => {
		const key = parseKey("run1/scheduler/sol-high/scheduler/sol-high/a1/r1/7/ENUM-SO2/f2");
		expect(key.task).toBe("scheduler");
		expect(key.arm).toBe("ENUM-SO2");
		expect(rowKeyOf("run1/scheduler/sol-high/a1/r1/7/ENUM-SO2/f2")).toBe("run1/scheduler/sol-high/a1/r1/7/ENUM-SO2");
	});
});

describe("end-to-end rescore against the frozen artifacts (integration)", () => {
	let out;
	beforeAll(() => {
		const payloads = mkdtempSync(join(tmpdir(), "capstone-rescore-payloads-"));
		execFileSync("tar", ["xzf", "experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz", "-C", payloads]);
		const oldPayloads = mkdtempSync(join(tmpdir(), "capstone-rescore-old-"));
		execFileSync("tar", ["xzf", "experiments/artifacts/2026-08-02-openai-trajectory/payloads.tar.gz", "-C", oldPayloads]);
		out = mkdtempSync(join(tmpdir(), "capstone-rescore-out-"));
		// The frozen capstone table was judged against golden v2; score it
		// against the frozen v2 copy so the live dataset can move on.
		execFileSync("node", [
			"experiments/capstone-score.mjs",
			"--output", out,
			"--payloads-fresh", payloads,
			"--payloads-old", oldPayloads,
			"--dataset", "experiments/artifacts/2026-08-03-golden-dataset-v2-final/repo--experiments--golden-dataset.json.gz",
			"--expect-version", "0aadc215658a775b",
		], { stdio: "pipe" });
	}, 120000);

	it("produces the fresh comparison with the payload-primary quiet columns armed (A1 prediction floor)", () => {
		const fresh = JSON.parse(readFileSync(join(out, "comparison-fresh.json"), "utf8"));
		expect(fresh.rows).toHaveLength(12);
		const sum = (arm) => fresh.rows.filter((row) => row.arm === arm).reduce((total, row) => total + row.quietSpanDeliveries, 0);
		// ITERATION1-DATA-PASS: opening spans alone imply at least 14 / 11.
		expect(sum("MAIN-SO2")).toBeGreaterThanOrEqual(14);
		expect(sum("ENUM-SO2")).toBeGreaterThanOrEqual(11);
	});

	it("carries the new registered columns on every row", () => {
		for (const input of ["fresh", "old"]) {
			const table = JSON.parse(readFileSync(join(out, `comparison-${input}.json`), "utf8"));
			for (const row of table.rows) {
				expect(row.absoluteNoise).toBeGreaterThanOrEqual(0);
				expect(row.precisionValid.raised).toBeLessThanOrEqual(row.precision.raised);
				expect(row.precisionRows.raised).toBeLessThanOrEqual(row.precision.raised);
				expect(row.oneJudgeFloor.count).toBeGreaterThanOrEqual(row.oneJudgeFloor.blocking);
			}
		}
	});
});
