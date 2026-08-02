import { describe, expect, it } from "vitest";
import {
	activeCatalog,
	buildCapstoneJudgePrompt,
	buildFindingItems,
	deliveredFindings,
	parseCapstoneJudgments,
	recoverRunEndAssistant,
	stableBlindOrder,
	visiblePayload,
} from "./capstone-trajectory-judge-protocol.mjs";

const observation = (responseText, arm = "ENUM") => ({
	kind: "observation",
	valid: true,
	delivery: "steer",
	responseText,
	runId: "run",
	trajectoryId: "scheduler",
	config: "sol-high",
	pointId: "scheduler/sol-high/a1/r0/0",
	arm,
	capturedPayloadHash: "abc",
	capturedPayloadPath: "/tmp/payload.json",
});

describe("capstone trajectory judge protocol", () => {
	it("turns an ENUM array into separately attributable findings", () => {
		const row = observation(JSON.stringify({ findings: [
			{ action: "steer", message: "first defect" },
			{ action: "print", message: "second defect" },
		] }));
		expect(deliveredFindings(row)).toEqual([
			{ index: 0, message: "first defect" },
			{ index: 1, message: "second defect" },
		]);
		const items = buildFindingItems([row]);
		expect(items).toHaveLength(2);
		expect(items[0].sourceKey).not.toBe(items[1].sourceKey);
	});

	it("normalizes single-message JSON and footer prose without exposing delivery", () => {
		expect(deliveredFindings(observation('{"action":"steer","message":"json defect"}', "MAIN"))[0].message).toBe("json defect");
		expect(deliveredFindings(observation("footer defect\nDELIVERY: steer", "F2"))[0].message).toBe("footer defect");
	});

	it("removes encrypted reasoning while retaining user text and tool evidence", () => {
		const rendered = visiblePayload({
			instructions: "system",
			input: [
				{ role: "user", content: [{ type: "input_text", text: "request" }] },
				{ type: "reasoning", encrypted_content: "SECRET" },
				{ type: "function_call", name: "read", arguments: '{"path":"x"}' },
				{ type: "function_call_output", output: "source" },
			],
		});
		expect(rendered).toContain("request");
		expect(rendered).toContain("TOOL CALL read");
		expect(rendered).toContain("source");
		expect(rendered).not.toContain("SECRET");
	});

	it("recovers only the run-end assistant response from the next request", () => {
		const prefix = [{ role: "user", content: [{ type: "input_text", text: "request" }] }];
		const assistant = [
			{ type: "reasoning", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "plan" }] },
			{ type: "function_call", name: "edit", arguments: "{}" },
		];
		const next = { input: [...prefix, ...assistant, { type: "function_call_output", output: "done" }, { role: "user", content: [] }] };
		expect(recoverRunEndAssistant({ input: prefix }, next)).toEqual(assistant);
		expect(recoverRunEndAssistant({ input: prefix }, { input: prefix })).toBeNull();
	});

	it("hides arms, tiers, votes, and real issue ids from the prompt", () => {
		const dataset = { issues: [{ id: "SCHED-secret", task: "scheduler", status: "active", tier: "blocking", votes: { sol: true }, statement: "same defect" }] };
		const catalog = activeCatalog(dataset, "scheduler");
		const items = buildFindingItems([observation('{"findings":[{"message":"candidate"}]}')]);
		const { prompt } = buildCapstoneJudgePrompt({ items, visibleTranscript: "transcript", files: "files", catalog });
		expect(prompt).toContain("k01: same defect");
		expect(prompt).not.toContain("SCHED-secret");
		expect(prompt).not.toContain("blocking");
		expect(prompt).not.toContain("ENUM");
		expect(prompt).not.toContain('"sol":true');
	});

	it("orders blinded findings by hidden source hash rather than input arm order", () => {
		const a = { sourceKey: "run/task/config/point/MAIN/f0" };
		const b = { sourceKey: "run/task/config/point/ENUM/f0" };
		expect(stableBlindOrder([a, b])).toEqual(stableBlindOrder([b, a]));
	});

	it("accepts atomic multi-claim output and rejects unknown catalog matches", () => {
		const valid = JSON.stringify({ findings: [{ id: "j01", claims: [
			{ statement: "defect one", reasoning: "visible", centralSupported: true, unsupportedExtra: false, matches: ["k01"] },
			{ statement: "defect two", reasoning: "not visible", centralSupported: false, unsupportedExtra: false, matches: [] },
		] }] });
		expect(parseCapstoneJudgments(valid, 1, ["k01"])).toHaveLength(1);
		expect(parseCapstoneJudgments(valid.replace("k01", "k99"), 1, ["k01"])).toBeNull();
	});
});
