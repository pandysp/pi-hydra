import { describe, expect, it } from "vitest";
import { reconcile } from "./run-ledger.mjs";

const judgment = (sourceKey) => ({ judge: "sol", metric: "atomic-claims-v1", sourceKey });

describe("run ledger reconciliation", () => {
	it("leaves orphanhood unknown for a standalone judge freeze", () => {
		const result = reconcile([], [judgment("external/source")]);
		expect(result).toMatchObject({ judgments: 1, orphanJudgments: null, duplicateJudgments: 0 });
	});

	it("checks orphanhood when producer rows are present", () => {
		const rows = [{ model: "sol", case: "case", sample: 0, arm: "MAIN" }];
		expect(reconcile(rows, [judgment("sol/case/0/MAIN")]).orphanJudgments).toBe(0);
		expect(reconcile(rows, [judgment("external/source")]).orphanJudgments).toBe(1);
	});
});
