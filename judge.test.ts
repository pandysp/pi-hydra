import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildJudgeReport, classifyJudgeResponse } from "./judge";

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { content, stopReason } as AssistantMessage;
}
const json = { type: "text" as const, text: '{"findings":[]}' };
const call = { type: "toolCall" as const, name: "write", id: "id", arguments: { content: "PRIVATE" } };

describe("answers from heads without tools", () => {
	it.each([
		["error", "provider-error"], ["aborted", "aborted"], ["length", "truncated"],
		["toolUse", "blocked-tool-request"], ["stop", "blocked-tool-request"],
	] as const)("%s takes precedence over mixed tools and valid JSON", (stop, kind) => {
		const result = classifyJudgeResponse(response([call, json], stop));
		expect(result).toMatchObject({ decisions: null, errorKind: kind, parseError: null, attemptedTools: ["write"] });
		expect(buildJudgeReport(result) !== null).toBe(kind === "blocked-tool-request");
	});

	it("does not accept JSON as terminal when the provider still signals tool use", () => {
		expect(classifyJudgeResponse(response([json], "toolUse"))).toMatchObject({
			errorKind: "incomplete-response", decisions: null,
		});
	});

	it("rejects complete-looking JSON on a truncated response", () => {
		expect(classifyJudgeResponse(response([json], "length")).errorKind).toBe("truncated");
	});

	it("tells empty text and thinking apart from a valid empty findings list", () => {
		for (const content of [[], [{ type: "text" as const, text: " \n " }], [{ type: "thinking" as const, thinking: "private" }]]) {
			expect(classifyJudgeResponse(response(content))).toMatchObject({ errorKind: "empty-answer", decisions: null, parseError: null });
		}
		expect(classifyJudgeResponse(response([json]))).toMatchObject({ errorKind: null, decisions: [{ action: "noop" }] });
	});

	it("retains parser diagnostics without injecting them or arbitrary answer text", () => {
		const result = classifyJudgeResponse(response([{ type: "text", text: '{"findings":[{"action":"PRIVATE instructions"}]}' }]));
		expect(result.parseError).toContain("PRIVATE instructions");
		const report = buildJudgeReport(result)!;
		expect(report).toContain("Hydra error notice (not a user request or a head finding)");
		expect(report).toContain("Use that format in future checks.");
		expect(report).not.toMatch(/acknowledg|driver action/);
		expect(report).not.toContain("PRIVATE");
	});

	it("bounds displayed tool names and count", () => {
		const result = classifyJudgeResponse(response([
			{ ...call, name: "write\nPRIVATE instructions" },
			...Array.from({ length: 30 }, (_, i) => ({ ...call, name: `tool-${i}` })),
			{ type: "thinking", thinking: "PRIVATE" },
		], "toolUse"));
		expect(result.attemptedTools).toHaveLength(8);
		expect(result.attemptedTools[0]).toBe("(name omitted)");
		const report = buildJudgeReport(result)!;
		expect(report).not.toContain("PRIVATE");
		expect(report.length).toBeLessThan(1000);
	});
});
