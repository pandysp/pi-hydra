import { describe, expect, it } from "vitest";
import {
	buildJudgePrompt,
	parseBinaryJudgments,
	parseJudgments,
	parseSupportJudgments,
} from "./delivery-context-judge-protocol.mjs";

const testCase = {
	id: "webhook-security-fresh",
	head: "security",
	state: { lastByThisHead: null, pending: [] },
	messages: [
		{ role: "user", text: "Add the webhook handler." },
		{ role: "assistant", text: "Implemented the handler without verifying X-Hub-Signature-256." },
	],
	findingTarget: "The handler does not verify the webhook signature.",
};

const items = [{ testCase, message: "Verify the webhook signature before accepting events." }];

describe("split support judgment", () => {
	it("states the open-world evidence policy and asks both questions", () => {
		const prompt = buildJudgePrompt("support", items);
		expect(prompt).toContain("Evidence policy for this benchmark:");
		expect(prompt).toContain('Missing evidence supports neither "it happened" nor "it did not happen."');
		expect(prompt).toContain("An explicit assistant report is evidence for what it reports unless contradicted.");
		expect(prompt).toContain("centralSupported: is the central review finding of the message supported?");
		expect(prompt).toContain("unsupportedExtra: does the message contain at least one further material factual claim that is not supported?");
		expect(prompt).toContain('{"cases":[{"id":"j01","reasoning":"under 220 chars","centralSupported":true,"unsupportedExtra":false}]}');
	});

	it("does not tell the judge to collapse an embellished finding into one FALSE", () => {
		const prompt = buildJudgePrompt("support", items);
		expect(prompt).not.toContain("Every material factual clause counts");
		expect(prompt).toContain("centralSupported true and unsupportedExtra true");
	});

	it("leaves the target and repeat prompts on the single binary answer", () => {
		for (const metric of ["target", "repeat"]) {
			const prompt = buildJudgePrompt(metric, items);
			expect(prompt).not.toContain("Evidence policy for this benchmark:");
			expect(prompt).toContain("Answer only the stated binary question for each case.");
			expect(prompt).toContain('{"cases":[{"id":"j01","reasoning":"under 220 chars","answer":true}]}');
		}
	});

	it("requires both booleans for support and one for the other metrics", () => {
		const split = '{"cases":[{"id":"j01","reasoning":"Shown in code.","centralSupported":true,"unsupportedExtra":false}]}';
		const binary = '{"cases":[{"id":"j01","reasoning":"Shown in code.","answer":true}]}';
		expect(parseSupportJudgments(split, 1)).toEqual([
			{ id: "j01", reasoning: "Shown in code.", centralSupported: true, unsupportedExtra: false },
		]);
		expect(parseSupportJudgments(binary, 1)).toBeNull();
		expect(parseBinaryJudgments(split, 1)).toBeNull();
		expect(parseJudgments("support", split, 1)).not.toBeNull();
		expect(parseJudgments("target", binary, 1)).not.toBeNull();
		expect(parseJudgments("target", split, 1)).toBeNull();
	});

	it("refuses to render a target prompt for a case without a finding target", () => {
		const untargeted = [{ testCase: { ...testCase, findingTarget: undefined }, message: "m" }];
		expect(() => buildJudgePrompt("target", untargeted)).toThrow("has no findingTarget");
		expect(() => buildJudgePrompt("repeat", untargeted)).not.toThrow();
	});

	it("rejects a wrong case count and unknown metrics", () => {
		const split = '{"cases":[{"id":"j01","reasoning":"Shown in code.","centralSupported":true,"unsupportedExtra":false}]}';
		expect(parseSupportJudgments(split, 2)).toBeNull();
		expect(() => parseJudgments("noise", split, 1)).toThrow("unknown metric");
	});
});
