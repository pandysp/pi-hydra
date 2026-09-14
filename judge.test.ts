import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { buildJudgeReport, classifyJudgeResponse, JudgeReports } from "./judge";

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
	return { content, stopReason } as AssistantMessage;
}
const json = { type: "text" as const, text: '{"findings":[]}' };
const call = { type: "toolCall" as const, name: "write", id: "id", arguments: { content: "PRIVATE" } };

describe("judge response classification", () => {
	it.each([
		["error", "provider-error"], ["aborted", "aborted"], ["length", "truncated"],
		["toolUse", "blocked-tool-request"], ["stop", "blocked-tool-request"],
	] as const)("%s takes precedence over mixed tools and valid JSON", (stop, kind) => {
		const result = classifyJudgeResponse(response([call, json], stop));
		expect(result).toMatchObject({ decisions: null, errorKind: kind, parseError: null, attemptedTools: ["write"] });
		expect(buildJudgeReport("quality", result) !== null).toBe(kind === "blocked-tool-request");
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
		const report = buildJudgeReport("quality", result)!;
		expect(report.content).toContain("Hydra runtime report (not a user request or a lens finding)");
		expect(report.content).toContain("you need not acknowledge");
		expect(JSON.stringify(report)).not.toContain("PRIVATE");
	});

	it("bounds displayed names and tool count while retaining exact head identity in metadata", () => {
		const result = classifyJudgeResponse(response([
			{ ...call, name: "write\nPRIVATE instructions" },
			...Array.from({ length: 30 }, (_, i) => ({ ...call, name: `tool-${i}` })),
			{ type: "thinking", thinking: "PRIVATE" },
		], "toolUse"));
		expect(result.attemptedTools).toHaveLength(8);
		expect(result.attemptedTools[0]).toBe("(name omitted)");
		const report = buildJudgeReport("head-".repeat(100), result)!;
		expect(JSON.stringify(report)).not.toContain("PRIVATE");
		expect(report.details.head).toBe("head-".repeat(100));
		expect(report.content.length).toBeLessThan(1000);
		const other = buildJudgeReport("head-".repeat(101), result)!;
		expect(other.details.head).not.toBe(report.details.head);
		const reports = new JudgeReports();
		expect(reports.stage(report.details)).toBe(true);
		expect(reports.stage(other.details)).toBe(true);
	});
});

describe("judge report receipts", () => {
	const report = () => buildJudgeReport("quality", classifyJudgeResponse(response([call], "toolUse")))!;
	it("only restores actual runtime custom messages, not call or attempted-send records", () => {
		const reports = new JudgeReports();
		const { details } = report();
		reports.restore([{ type: "custom", customType: "hydra-runtime-report", details }]);
		expect(reports.stage(details)).toBe(true);
		expect(reports.stage(details)).toBe(false);
		expect(reports.settle()).toBe(1);
		expect(reports.stage(details)).toBe(true);
		reports.sync([{ type: "custom_message", customType: "hydra-runtime-report", details }]);
		expect(reports.settle()).toBe(0);
		expect(reports.stage(details)).toBe(false);
		reports.restore([]);
		expect(reports.stage(details)).toBe(true);
	});

	it("ignores malformed restored metadata rather than throwing during navigation", () => {
		const reports = new JudgeReports();
		for (const details of [undefined, null, {}, { head: 42, errorKind: "blocked-tool-request" }]) {
			reports.consume(details);
		}
		expect(reports.stage(report().details)).toBe(true);
	});
});
