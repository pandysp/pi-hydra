import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectCheckpointedBatches } from "./golden-dataset-consensus.mjs";

const temporary = [];

afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function label(id, reason) {
	return { [id]: { blocking: true, anyHarm: true, reason } };
}

describe("golden consensus provider checkpoints", () => {
	it("resumes after an Opus failure without rerunning or overwriting Sol", async () => {
		const stateDir = mkdtempSync(join(tmpdir(), "golden-resume-"));
		temporary.push(stateDir);
		const batches = [{ key: "scheduler:seed", items: [{ id: "CL38" }] }];
		const promptFor = () => "stable prompt";
		let solCalls = 0;
		let opusCalls = 0;

		await collectCheckpointedBatches({
			name: "sol",
			round: 1,
			stateDir,
			batches,
			promptFor,
			timeoutMs: 10,
			ask: async () => {
				solCalls++;
				return { labels: label("CL38", "sol saved"), attempts: [{ text: "sol" }], judge: { name: "sol" } };
			},
		});
		const solPath = join(stateDir, "judge-round1-sol.json");
		const solBytes = readFileSync(solPath, "utf8");

		await expect(
			collectCheckpointedBatches({
				name: "opus",
				round: 1,
				stateDir,
				batches,
				promptFor,
				timeoutMs: 10,
				ask: async () => {
					opusCalls++;
					throw Object.assign(new Error("provider unavailable"), { attempts: [{ error: "limit" }] });
				},
			}),
		).rejects.toThrow("provider unavailable");

		const resumedSol = await collectCheckpointedBatches({
			name: "sol",
			round: 1,
			stateDir,
			batches,
			promptFor,
			timeoutMs: 10,
			ask: async () => {
				throw new Error("saved Sol batch was rerun");
			},
		});
		const resumedOpus = await collectCheckpointedBatches({
			name: "opus",
			round: 1,
			stateDir,
			batches,
			promptFor,
			timeoutMs: 10,
			ask: async () => {
				opusCalls++;
				return { labels: label("CL38", "opus resumed"), attempts: [{ text: "opus" }], judge: { name: "opus" } };
			},
		});

		expect(solCalls).toBe(1);
		expect(opusCalls).toBe(2);
		expect(resumedSol).toEqual(label("CL38", "sol saved"));
		expect(resumedOpus).toEqual(label("CL38", "opus resumed"));
		expect(readFileSync(solPath, "utf8")).toBe(solBytes);
		const opusCheckpoint = JSON.parse(readFileSync(join(stateDir, "judge-round1-opus.json"), "utf8"));
		expect(opusCheckpoint.failures).toHaveLength(1);
		expect(opusCheckpoint.batches).toHaveLength(1);
	});
});
