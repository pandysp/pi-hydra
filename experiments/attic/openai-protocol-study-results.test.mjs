import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeStudy } from "./openai-protocol-study-results.mjs";

const dirs = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenAI protocol study results", () => {
	it("keeps an accepted batch authoritative when a later retry fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hydra-study-results-"));
		dirs.push(dir);
		const producerPath = join(dir, "rows.jsonl");
		const judgePath = join(dir, "judge.jsonl");
		const source = "sol-high/fresh-archive-live-restore/1/ENUM-SO2/0";
		const key = `b-${createHash("sha256").update(`openai-protocol-study-v1/${source}`).digest("hex").slice(0, 16)}`;
		writeFileSync(
			producerPath,
			`${JSON.stringify({
				kind: "openai-protocol-study-row",
				config: "sol-high",
				caseId: "fresh-archive-live-restore",
				sample: 1,
				arm: "ENUM-SO2",
				family: "multi-finding",
				findings: [{ reason: "path escapes", message: "Constrain it.", action: "steer" }],
				usage: { output: 10 },
				cost: 0.01,
				capsValid: true,
			})}\n`,
		);
		writeFileSync(
			judgePath,
			[
				{
					kind: "openai-protocol-study-judge-batch",
					batchId: "fresh-archive-live-restore/01",
					judgments: [{ key, supported: true, unsupportedExtra: false, matchedIssueIds: ["archive-path-escape"], actionable: true }],
					cost: 0.02,
				},
				{
					kind: "openai-protocol-study-judge-batch",
					batchId: "fresh-archive-live-restore/01",
					candidates: [{ key }],
					error: "transport failed",
				},
			].map((row) => JSON.stringify(row)).join("\n") + "\n",
		);

		const result = analyzeStudy({ producerPath, judgePath });
		expect(result.judge).toMatchObject({
			batchAttempts: 2,
			uniqueBatches: 1,
			acceptedBatches: 1,
			acceptedJudgments: 1,
			unjudgedFindings: 0,
		});
		expect(result.cells[0].coverage).toMatchObject({
			found: 1,
			issues: 3,
			blockingFound: 1,
			blockingIssues: 3,
		});
	});
});
