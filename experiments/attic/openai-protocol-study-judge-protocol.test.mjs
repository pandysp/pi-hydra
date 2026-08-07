import { describe, expect, it } from "vitest";
import {
	buildStudyJudgePrompt,
	parseStudyJudgeResponse,
} from "./openai-protocol-study-judge-protocol.mjs";

const testCase = {
	messages: [{ role: "assistant", text: "Writes before checking the checksum." }],
	issues: [{ id: "late-check", target: "Check before writing." }],
};

describe("OpenAI protocol study judge protocol", () => {
	it("hides arm metadata and freezes the specific-consequence boundary", () => {
		const prompt = buildStudyJudgePrompt({
			testCase,
			candidates: [{ key: "blind-1", reason: "late", message: "Checksum is checked after overwrite." }],
		});
		expect(prompt).toContain("generic mechanism must not inherit a specific consequence");
		expect(prompt).not.toContain("ENUM-SO2");
	});

	it("accepts each exact key and registered issue once", () => {
		const parsed = parseStudyJudgeResponse(
			JSON.stringify({
				judgments: [
					{
						key: "blind-1",
						supported: true,
						unsupportedExtra: false,
						matchedIssueIds: ["late-check"],
						actionable: true,
						reason: "visible",
					},
				],
			}),
			["blind-1"],
			new Set(["late-check"]),
		);
		expect(parsed.error).toBeNull();
	});
});
