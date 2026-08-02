import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./fingerprints.mjs";
import { executeCapstoneJudgePass } from "./capstone-trajectory-judge.mjs";

const response = (count) => JSON.stringify({
	findings: Array.from({ length: count }, (_, index) => ({
		id: `j${String(index + 1).padStart(2, "0")}`,
		claims: [{ statement: `defect ${index + 1}`, reasoning: "visible", centralSupported: true, unsupportedExtra: false, matches: ["k01"] }],
	})),
});

describe("capstone trajectory judge resume", () => {
	it("checkpoints a completed judge and makes a replay perform no calls", async () => {
		const dir = mkdtempSync(join(tmpdir(), "capstone-judge-"));
		const payload = JSON.stringify({ instructions: "system", input: [{ role: "user", content: [{ type: "input_text", text: "request" }] }] });
		const payloadHash = sha256Hex(payload).slice(0, 16);
		writeFileSync(join(dir, "payload.json"), payload);
		const base = { runId: "run", trajectoryId: "scheduler", config: "sol-high", pointId: "p1" };
		const rows = [
			{ ...base, kind: "observation", arm: "MAIN", valid: true, delivery: "steer", responseText: '{"message":"one"}', capturedPayloadHash: payloadHash, capturedPayloadPath: "/old/payload.json" },
			{ ...base, kind: "observation", arm: "ENUM", valid: true, delivery: "steer", responseText: '{"findings":[{"message":"two"},{"message":"three"}]}', capturedPayloadHash: payloadHash, capturedPayloadPath: "/old/payload.json" },
			{ ...base, kind: "file-state", files: { "src/a.js": "export const a = 1;" } },
		];
		const dataset = { version: "candidate", issues: [{ id: "SCHED-1", task: "scheduler", status: "active", statement: "same defect" }] };
		const outputPath = join(dir, "sol.json");
		let calls = 0;
		const transport = { model: "gpt-5.6-sol", async ask() { calls++; return { text: response(3), error: null }; } };
		const first = await executeCapstoneJudgePass({ rows, dataset, payloadDir: dir, outputPath, judgeName: "sol", transport, inputIdentity: { fixture: "v1" } });
		expect(first.status).toBe("complete");
		expect(Object.keys(first.judgments)).toHaveLength(3);
		expect(calls).toBe(1);

		const noCall = { model: "gpt-5.6-sol", async ask() { throw new Error("completed work was replayed"); } };
		const second = await executeCapstoneJudgePass({ rows, dataset, payloadDir: dir, outputPath, judgeName: "sol", transport: noCall, inputIdentity: { fixture: "v1" } });
		expect(second.status).toBe("complete");
		expect(JSON.parse(readFileSync(outputPath, "utf8")).batches).toHaveLength(1);
	});

	it("refuses to append when frozen input identity changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "capstone-judge-drift-"));
		const outputPath = join(dir, "sol.json");
		writeFileSync(outputPath, JSON.stringify({ metadata: { old: true }, status: "in-progress", judgments: {}, batches: [], failures: [] }));
		await expect(executeCapstoneJudgePass({
			rows: [],
			dataset: { version: "v", issues: [] },
			payloadDir: dir,
			outputPath,
			judgeName: "sol",
			transport: { model: "gpt-5.6-sol", async ask() { throw new Error("unused"); } },
			inputIdentity: { new: true },
		})).rejects.toThrow(/metadata differs/);
	});
});
