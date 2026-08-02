import { describe, expect, it } from "vitest";
import { renderCapstoneTable } from "./render-capstone-table.mjs";

describe("capstone comparison renderer", () => {
	it("renders costs while leaving unavailable quality visibly blank", () => {
		const table = renderCapstoneTable({
			datasetVersion: null,
			rows: [{ task: "scheduler", config: "sol-high", arm: "ENUM-SO2", costPerObservation: 0.027, observerDriverPercent: 69.1 }],
		});
		expect(table).toContain("| scheduler | sol-high | ENUM-SO2 | $0.0270 | 69.1% | — | — | — | — | — | — |");
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
});
