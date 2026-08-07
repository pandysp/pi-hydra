import { describe, expect, it } from "vitest";
import { renderCapstoneTable } from "./render-capstone-table.mjs";

describe("capstone comparison renderer", () => {
	it("renders costs while leaving unavailable quality visibly blank", () => {
		const table = renderCapstoneTable({
			datasetVersion: null,
			rows: [{ task: "scheduler", config: "sol-high", arm: "ENUM-SO2", costPerObservation: 0.027, observerDriverPercent: 69.1 }],
		});
		expect(table).toContain("| scheduler | sol-high | ENUM-SO2 | $0.0270 | 69.1% | — | — | — | — | — | — | — | — |");
		expect(table).toContain("Quality cells marked — are intentionally unscored");
	});

	it("derives separate any-harm and registered weighted recall values", () => {
		const table = renderCapstoneTable({
			datasetVersion: "v2",
			rows: [{
				task: "scheduler",
				config: "sol-high",
				arm: "MAIN-SO2",
				costPerObservation: 0.02,
				observerDriverPercent: 50,
				blocking: { found: 2, total: 4 },
				harmful: { found: 3, total: 6 },
				precision: { real: 5, raised: 7 },
				absoluteNoise: 2,
				quietSpanDeliveries: 1,
			}],
		});
		expect(table).toContain("2/4 (50.0%)");
		expect(table).toContain("5/10 (50.0%)");
		expect(table).toContain("5/7 (71.4%)");
		expect(table).toContain("7/14 (50.0%)");
	});

	it("renders the registered noise reading even when it differs from raised − real (A3)", () => {
		const table = renderCapstoneTable({
			datasetVersion: "v2",
			rows: [{
				task: "dispatcher",
				config: "sol-high",
				arm: "ENUM-SO2",
				costPerObservation: 0.027,
				observerDriverPercent: 84.4,
				blocking: { found: 1, total: 3 },
				harmful: { found: 3, total: 9 },
				precision: { real: 31, raised: 38 },
				precisionValid: { real: 29, raised: 34 },
				absoluteNoise: 7,
				oneJudgeFloor: { count: 3, blocking: 1 },
				quietSpanDeliveries: 0,
			}],
		});
		// raised − real would be 7 here too by coincidence in iteration 1; use
		// a differing pair to pin the wiring:
		const differing = renderCapstoneTable({
			datasetVersion: "v2",
			rows: [{
				task: "scheduler", config: "sol-high", arm: "ENUM-SO2",
				costPerObservation: 0.03, observerDriverPercent: 76.3,
				blocking: { found: 2, total: 15 }, harmful: { found: 9, total: 25 },
				precision: { real: 21, raised: 25 },
				absoluteNoise: 1,
				quietSpanDeliveries: 0,
			}],
		});
		expect(differing).toContain("| 1 |");
		expect(differing).not.toContain("| 4 |");
		expect(table).toContain("| 29/34 (85.3%) |");
		expect(table).toContain("| 3 (1b) |");
		expect(table).toContain("both-judges-not-real");
	});

	it("refuses an absoluteNoise outside the raised range", () => {
		expect(() => renderCapstoneTable({
			datasetVersion: "v2",
			rows: [{
				task: "scheduler", config: "sol-high", arm: "MAIN-SO2",
				costPerObservation: 0.02, observerDriverPercent: 50,
				blocking: { found: 1, total: 2 }, harmful: { found: 1, total: 2 },
				precision: { real: 1, raised: 2 },
				absoluteNoise: 5,
			}],
		})).toThrow(/out of range/);
	});
});
