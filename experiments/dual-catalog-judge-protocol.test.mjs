import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { visiblePayload } from "./capstone-trajectory-judge-protocol.mjs";
import {
	DUAL_CATALOG_JUDGE_SYSTEM_PROMPT,
	buildDualCatalogJudgePrompt,
	dualCatalogJudgeBuilderHash,
	dualCatalogJudgeSystemHash,
	parseDualCatalogJudgments,
} from "./dual-catalog-judge-protocol.mjs";

const catalog = {
	task: "scheduler",
	versions: { real: "real-version", false: "false-version" },
	real: [{
		key: "r01",
		id: "SCHED-secret-real-id",
		statement: "A swept job retains its owner and cannot be claimed again.",
		severity: "severe",
		provenance: ["planted"],
		applicability: {},
		dissent: null,
	}],
	false: [{
		key: "f01",
		id: "FP-secret-false-id",
		statement: "The timeout table ends with a stray closing brace.",
		severity: "minor",
		invalidBecause: "Secret false-catalog explanation.",
		applicability: {},
		provenance: [],
		dissent: null,
	}],
};

const item = {
	sourceKey: "run/scheduler/sol-high/point/ENUM-SO2/f0",
	runId: "run-private-1234",
	pointKey: "run-private-1234/scheduler/sol-high/point",
	pointId: "point-private-1234",
	task: "scheduler",
	config: "sol-high",
	arm: "ENUM-SO2",
	message: "The swept job retains its owner and cannot be claimed again.",
};
const judgedItem = { ...item, judgeMessage: item.message };

const finding = (fields = {}) => ({
	id: "j01",
	realMatches: ["r01"],
	falseMatches: [],
	quote: "retains its owner",
	unmatched: null,
	reasoning: "The finding states the cataloged reclaim failure.",
	...fields,
});

const response = (entry = finding()) => JSON.stringify({ findings: [entry] });

describe("expanded 2Q judge protocol", () => {
	it("returns a stable custom system message separately from blinded batch evidence", () => {
		const built = buildDualCatalogJudgePrompt({
			items: [item],
			visibleTranscript: "SYSTEM\nYou are pi in /tmp/hydra-traj-scheduler-sol-high-AbC123. Benchmark nonce: run-private-1234. Config sol-high.",
			files: "file evidence from ENUM-SO2",
			catalog,
		});
		expect(built.systemPrompt).toBe(DUAL_CATALOG_JUDGE_SYSTEM_PROMPT);
		expect(built.userPrompt).toContain("r01: A swept job retains its owner");
		expect(built.userPrompt).toContain("f01: The timeout table ends");
		expect(built.userPrompt).toContain(JSON.stringify(item.message));
		expect(built.userPrompt).not.toContain("SCHED-secret-real-id");
		expect(built.userPrompt).not.toContain("FP-secret-false-id");
		expect(built.userPrompt).not.toContain("Secret false-catalog explanation");
		expect(built.userPrompt).not.toContain("ENUM-SO2");
		expect(built.userPrompt).not.toContain("sol-high");
		expect(built.userPrompt).not.toContain("run-private-1234");
		expect(built.userPrompt).not.toContain("/tmp/hydra-traj-");
		expect(built.userPrompt).toContain("<benchmark-workspace>");
		expect(built.userPrompt).toContain("Benchmark nonce: <hidden>");
		expect(built.ordered[0].message).toBe(item.message);
		expect(built.userPrompt).not.toContain("unsupportedExtra");
		expect(built.userPrompt).not.toContain('"claims"');
		expect(built.systemPrompt).toContain("process advice, not evidence that a defect exists");
		expect(built.systemPrompt).toContain('Never invent\n"missing test coverage"');
		expect(built.userPrompt).toContain("only process advice and asserts no present defect");
	});

	it("orders findings by the inherited stable blind order", () => {
		const other = { ...item, sourceKey: "run/scheduler/sol-high/point/MAIN-SO2/f0", arm: "MAIN-SO2", message: "Another exact finding." };
		const a = buildDualCatalogJudgePrompt({ items: [item, other], visibleTranscript: "", files: "", catalog });
		const b = buildDualCatalogJudgePrompt({ items: [other, item], visibleTranscript: "", files: "", catalog });
		expect(a.ordered).toEqual(b.ordered);
		expect(a.userPrompt).toBe(b.userPrompt);
	});

	it("fails closed before transport when a point contains too many findings", () => {
		const items = Array.from({ length: 13 }, (_, index) => ({
			...item,
			sourceKey: `${item.sourceKey}-${index}`,
			message: `Finding ${index}.`,
		}));
		expect(() => buildDualCatalogJudgePrompt({ items, visibleTranscript: "", files: "", catalog }))
			.toThrow(/at most 12 findings/);
	});

	it("blinds short legacy arm ids without corrupting larger identifiers", () => {
		const legacy = { ...item, sourceKey: "run/scheduler/sol-high/point/F2/f0", arm: "F2" };
		const built = buildDualCatalogJudgePrompt({
			items: [legacy],
			visibleTranscript: "Arm F2 used function ENUMERATE and MAINLINE constants.",
			files: "",
			catalog,
		});
		expect(built.userPrompt).not.toContain("Arm F2");
		expect(built.userPrompt).toContain("ENUMERATE");
		expect(built.userPrompt).toContain("MAINLINE");
	});

	it("blinds producer identity embedded in an actual frozen payload", () => {
		const archive = fileURLToPath(new URL("./artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz", import.meta.url));
		const payload = JSON.parse(execFileSync("tar", ["-xOf", archive, "payloads/scheduler-sol-high-a1-r0-q4.json"], { encoding: "utf8" }));
		const built = buildDualCatalogJudgePrompt({ items: [item], visibleTranscript: visiblePayload(payload), files: "FILE src/a.js\nexport const a = 1;", catalog });
		expect(built.userPrompt).not.toContain("/tmp/hydra-traj-");
		expect(built.userPrompt).not.toContain("sol-high");
		expect(built.userPrompt).toContain("<benchmark-workspace>");
	});

	it("accepts real and false catalog matches and all valid unmatched outcomes", () => {
		const ordered = [judgedItem];
		expect(parseDualCatalogJudgments(response(), ordered, catalog)).toHaveLength(1);
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], falseMatches: ["f01"] })), ordered, catalog)).toHaveLength(1);
		for (const unmatched of [
			{ truth: "real", severity: "severe" },
			{ truth: "real", severity: "minor" },
			{ truth: "false", severity: "severe" },
			{ truth: "false", severity: "minor" },
			{ truth: "unclear", severity: null },
		]) {
			const text = response(finding({ realMatches: [], falseMatches: [], unmatched }));
			expect(parseDualCatalogJudgments(text, ordered, catalog)).toHaveLength(1);
		}
	});

	it("rejects bad ids/order, non-substring quotes, unknown or duplicate keys, and cross-lane matches", () => {
		const ordered = [judgedItem];
		expect(parseDualCatalogJudgments(response(finding({ id: "j02" })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ quote: "not in the finding" })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: ["r99"] })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: ["r01", "r01"] })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: ["f01"] })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: ["r01"], falseMatches: ["f01"] })), ordered, catalog)).toBeNull();
	});

	it("rejects matched-plus-unmatched and malformed unmatched truth/severity pairs", () => {
		const ordered = [judgedItem];
		expect(parseDualCatalogJudgments(response(finding({ unmatched: { truth: "real", severity: "severe" } })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], unmatched: null })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], unmatched: { truth: "unclear", severity: "minor" } })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], unmatched: { truth: "real", severity: null } })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], unmatched: { truth: "other", severity: "minor" } })), ordered, catalog)).toBeNull();
	});

	it("rejects extra fields, blank or overlong reasoning, and non-JSON wrappers", () => {
		const ordered = [judgedItem];
		expect(parseDualCatalogJudgments(JSON.stringify({ findings: [finding()], extra: true }), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response({ ...finding(), extra: true }), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ realMatches: [], unmatched: { truth: "real", severity: "minor", extra: true } })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ reasoning: " " })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(response(finding({ reasoning: "x".repeat(241) })), ordered, catalog)).toBeNull();
		expect(parseDualCatalogJudgments(`\`\`\`json\n${response()}\n\`\`\``, ordered, catalog)).toBeNull();
	});

	it("accepts a decoded multi-line quote and rejects parser inputs without blinded text", () => {
		const multiLine = { ...item, message: "First defect line.\nSecond defect line.", judgeMessage: "First defect line.\nSecond defect line." };
		const answer = response(finding({ realMatches: [], quote: "First defect line.\nSecond defect line.", unmatched: { truth: "real", severity: "minor" } }));
		expect(parseDualCatalogJudgments(answer, [multiLine], catalog)).toHaveLength(1);
		expect(() => parseDualCatalogJudgments(response(), [item], catalog)).toThrow(/missing blinded judgeMessage/);
	});

	it("freezes stable system and full builder hashes", () => {
		expect(dualCatalogJudgeSystemHash()).toMatch(/^[0-9a-f]{16}$/);
		expect(dualCatalogJudgeBuilderHash()).toMatch(/^[0-9a-f]{16}$/);
		expect(dualCatalogJudgeBuilderHash()).toBe(dualCatalogJudgeBuilderHash());
	});
});
