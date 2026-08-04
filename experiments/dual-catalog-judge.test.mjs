import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./fingerprints.mjs";
import { executeDualCatalogJudgePass } from "./dual-catalog-judge.mjs";
import { piReplayTransformHash } from "./pi-replay-judge-transport.mjs";
import realCatalog from "./golden-dataset.json" with { type: "json" };
import falseCatalog from "./false-positive-catalog.json" with { type: "json" };

function answer({ truth = "real", severity = "minor" } = {}) {
	return JSON.stringify({ findings: [{
		id: "j01", realMatches: [], falseMatches: [], quote: "candidate defect",
		unmatched: { truth, severity }, reasoning: "The visible source establishes this outcome.",
	}] });
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "dual-catalog-judge-"));
	const payload = JSON.stringify({ instructions: "driver", input: [{ role: "user", content: [{ type: "input_text", text: "request" }] }] });
	const hash = sha256Hex(payload).slice(0, 16);
	writeFileSync(join(dir, "payload.json"), payload);
	const base = { runId: "run", trajectoryId: "scheduler", config: "sol-high", pointId: "p1" };
	return {
		dir,
		rows: [
			{ ...base, kind: "observation", arm: "ENUM", valid: true, delivery: "steer", responseText: '{"findings":[{"message":"candidate defect"}]}', capturedPayloadHash: hash, capturedPayloadPath: "/old/payload.json", pointKind: "piggyback" },
			{ ...base, kind: "file-state", files: { "src/a.js": "export const a = 1;" } },
		],
	};
}

function transport(responses, calls) {
	return {
		name: "pi-replay", judgeName: "sol", provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high",
		shapeIdentity: { archive: "fixture.tar.gz", member: "payloads/fixture.json", sha256: "a".repeat(64) },
		transformHash: piReplayTransformHash(),
		routeIdentity: { packageLockSha256: "b".repeat(64), api: "openai-codex-responses", baseUrl: null },
		async ask(_request, prior) {
			calls.push(prior ? "correction" : "initial");
			const next = responses.shift();
			return { text: next.text, error: next.error ?? null, invalid: next.invalid ?? null, raw: { role: "assistant", content: [{ type: "text", text: next.text }] } };
		},
	};
}

function runArgs(f, outputPath, tx) {
	return { rows: f.rows, realCatalog, falseCatalog, payloadDir: f.dir, outputPath, judgeName: "sol", transport: tx, inputIdentity: { fixture: "v1" } };
}

describe("expanded 2Q judge runner", () => {
	it("checkpoints a valid batch and makes a completed replay perform zero calls", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		const calls = [];
		const first = await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: answer() }], calls)));
		expect(first.status).toBe("complete");
		expect(calls).toEqual(["initial"]);
		const noCalls = transport([], []);
		noCalls.ask = async () => { throw new Error("completed work replayed"); };
		const second = await executeDualCatalogJudgePass(runArgs(f, output, noCalls));
		expect(second.status).toBe("complete");
	});

	it("allows exactly one schema correction and keeps the real assistant role", async () => {
		const f = fixture();
		const calls = [];
		const state = await executeDualCatalogJudgePass(runArgs(f, join(f.dir, "state.json"), transport([
			{ text: "not json" }, { text: answer({ truth: "false", severity: "minor" }) },
		], calls)));
		expect(calls).toEqual(["initial", "correction"]);
		expect(state.status).toBe("complete");
		expect(Object.values(state.judgments)[0].unmatched.truth).toBe("false");
		expect(state.attempts.map((attempt) => attempt.phase)).toEqual(["initial", "format-correction"]);
	});

	it("makes a second invalid answer terminal across restart", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		const calls = [];
		const state = await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: "bad" }, { text: "still bad" }], calls)));
		expect(state.status).toBe("complete-with-exceptions");
		expect(Object.keys(state.invalidOutputs)).toHaveLength(1);
		expect(calls).toEqual(["initial", "correction"]);
		const persisted = JSON.parse(readFileSync(output, "utf8"));
		expect(persisted.corrections).toEqual({});
		const replayCalls = [];
		await executeDualCatalogJudgePass(runArgs(f, output, transport([], replayCalls)));
		expect(replayCalls).toEqual([]);
	});

	it("refuses checkpoint reuse when catalog or carrier identity drifts", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: answer() }], [])));
		const changed = transport([], []);
		changed.shapeIdentity = { archive: "other.tar.gz", member: "payloads/other.json", sha256: "c".repeat(64) };
		await expect(executeDualCatalogJudgePass(runArgs(f, output, changed))).rejects.toThrow(/checkpoint metadata differs/);
	});

	it("reuses a durably answered attempt after a crash instead of calling the provider again", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: answer() }], [])));
		const crashed = JSON.parse(readFileSync(output, "utf8"));
		crashed.status = "in-progress";
		crashed.judgments = {};
		crashed.batches = [];
		delete crashed.completedAt;
		writeFileSync(output, `${JSON.stringify(crashed, null, 2)}\n`);
		const calls = [];
		const resumed = await executeDualCatalogJudgePass(runArgs(f, output, transport([], calls)));
		expect(resumed.status).toBe("complete");
		expect(calls).toEqual([]);
		expect(resumed.attempts).toHaveLength(1);
	});

	it("reuses a durably answered correction after a crash without buying a second correction", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: "bad" }, { text: answer() }], [])));
		const crashed = JSON.parse(readFileSync(output, "utf8"));
		const pointKey = crashed.batches[0].pointKey;
		crashed.status = "in-progress";
		crashed.judgments = {};
		crashed.batches = [];
		crashed.corrections[pointKey] = {
			promptHash: crashed.attempts[0].promptHash,
			sourceKeys: crashed.attempts[0].sourceKeys,
			firstResponse: crashed.attempts[0].response,
			raw: crashed.attempts[0].raw,
		};
		delete crashed.completedAt;
		writeFileSync(output, `${JSON.stringify(crashed, null, 2)}\n`);
		const calls = [];
		const resumed = await executeDualCatalogJudgePass(runArgs(f, output, transport([], calls)));
		expect(resumed.status).toBe("complete");
		expect(calls).toEqual([]);
		expect(resumed.attempts).toHaveLength(2);
	});

	it("fails closed on an ambiguous started attempt unless retry is explicitly authorized", async () => {
		const f = fixture();
		const output = join(f.dir, "state.json");
		await executeDualCatalogJudgePass(runArgs(f, output, transport([{ text: answer() }], [])));
		const crashed = JSON.parse(readFileSync(output, "utf8"));
		crashed.status = "in-progress";
		crashed.judgments = {};
		crashed.batches = [];
		crashed.attempts[0].status = "started";
		delete crashed.attempts[0].response;
		delete crashed.completedAt;
		writeFileSync(output, `${JSON.stringify(crashed, null, 2)}\n`);
		await expect(executeDualCatalogJudgePass(runArgs(f, output, transport([], [])))).rejects.toThrow(/explicit retryAmbiguous/);
	});

	it("makes a provider tool call terminal-invalid without attempting an unsafe correction", async () => {
		const f = fixture();
		const calls = [];
		const state = await executeDualCatalogJudgePass(runArgs(f, join(f.dir, "state.json"), transport([
			{ text: answer(), invalid: "unsupported-judge-tool-call" },
		], calls)));
		expect(calls).toEqual(["initial"]);
		expect(state.status).toBe("complete-with-exceptions");
		expect(Object.values(state.invalidOutputs)[0].reason).toBe("unsupported-judge-tool-call");
	});
});
