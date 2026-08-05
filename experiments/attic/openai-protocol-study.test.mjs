import { describe, expect, it } from "vitest";
import {
	DEFAULT_SAMPLES,
	DEFAULT_STUDY_ARMS,
	DEFAULT_STUDY_CONFIGS,
	matrixBlocks,
	rowKey,
} from "./openai-protocol-study.mjs";

describe("registered OpenAI protocol-study matrix", () => {
	it("contains 144 calls before provider spend", () => {
		const blocks = matrixBlocks();
		expect(blocks).toHaveLength(9 * DEFAULT_STUDY_CONFIGS.length * DEFAULT_SAMPLES);
		expect(blocks.length * DEFAULT_STUDY_ARMS.length).toBe(144);
	});

	it("keys every resumable cell", () => {
		expect(rowKey({ config: "sol-high", caseId: "c", sample: 2, arm: "ENUM-SO2" })).toBe(
			"sol-high/c/2/ENUM-SO2",
		);
	});
});
