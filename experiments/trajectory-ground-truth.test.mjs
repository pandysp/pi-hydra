import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compileDefect, declarationOnDirectLine, defectStateInPayload, payloadChunks } from "./trajectory-ground-truth.mjs";
import { TRAJECTORY_TASKS } from "./trajectory-cost-tasks.mjs";

const TARBALL = "experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz";
const defect = (id) => compileDefect(TRAJECTORY_TASKS.flatMap((task) => task.defects).find((entry) => entry.id === id));

function jsonFilesUnder(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		if (entry.isDirectory()) return jsonFilesUnder(path);
		return entry.name.endsWith(".json") ? [path] : [];
	});
}

let payloadFiles = [];
const byName = new Map();
beforeAll(() => {
	const dir = mkdtempSync(join(tmpdir(), "capstone-payloads-"));
	execFileSync("tar", ["xzf", TARBALL, "-C", dir]);
	payloadFiles = jsonFilesUnder(dir).filter((path) => statSync(path).size > 0);
	for (const path of payloadFiles) byName.set(path.split("/").pop(), path);
});

const load = (name) => JSON.parse(readFileSync(byName.get(name), "utf8"));

describe("payload walker on the Responses-API shape (ITERATION1-DATA-PASS A1)", () => {
	it("produces chunks for every frozen capstone payload — the iteration-1 walker produced zero for all 131", () => {
		expect(payloadFiles.length).toBe(131);
		for (const path of payloadFiles) {
			expect(payloadChunks(JSON.parse(readFileSync(path, "utf8"))).length, path).toBeGreaterThan(0);
		}
	});

	it("finds authoritative defect-expression sightings across the corpus", () => {
		const expressions = TRAJECTORY_TASKS.flatMap((task) => task.defects).map(compileDefect);
		let withHits = 0;
		for (const path of payloadFiles) {
			const chunks = payloadChunks(JSON.parse(readFileSync(path, "utf8"))).filter((chunk) => chunk.authoritative);
			if (expressions.some((entry) => chunks.some((chunk) => entry.regex.test(chunk.text)))) withHits += 1;
		}
		expect(withHits).toBeGreaterThanOrEqual(80);
	});

	it("reads a defect back through function_call_output (q10 reproduction)", () => {
		const state = defectStateInPayload(load("dispatcher-sol-high-a1-r1-q10.json"), defect("retry-no-idempotency-key"));
		expect(state?.state).toBe("live");
		expect(state.chunk.authoritative).toBe(true);
	});

	it("parses string function_call arguments and keeps oldText non-authoritative (q16 reproduction)", () => {
		const state = defectStateInPayload(load("dispatcher-sol-high-a1-r2-q16.json"), defect("retry-swallowed-failure"));
		expect(state?.state).toBe("live");
		expect(state.chunk.kind).not.toBe("edit-old");
	});

	it("never lets a fix read as a re-plant via oldText (q18 reproduction)", () => {
		const state = defectStateInPayload(load("scheduler-sol-high-a1-r3-q18.json"), defect("sched-requeue-resets-attempts"));
		if (state) expect(state.chunk.kind).not.toBe("edit-old");
	});

	it("handles both message item shapes — bare role and type:message", () => {
		const payload = {
			input: [
				{ role: "user", content: [{ type: "input_text", text: "if (job.claimedBy === null) {" }] },
				{ type: "message", role: "assistant", content: [{ type: "output_text", text: "reading scheduler" }] },
			],
		};
		const chunks = payloadChunks(payload);
		expect(chunks).toHaveLength(2);
		expect(chunks.every((chunk) => chunk.authoritative)).toBe(true);
	});
});

describe("grep output cannot close a liveness window (ITERATION1-DATA-PASS A1, second bug)", () => {
	it("distinguishes grep-prefixed from direct declaration lines", () => {
		const declaration = defect("retry-swallowed-failure").declarationRegex;
		expect(declarationOnDirectLine("src/retry.js:12: export async function withRetries(operation) {", declaration)).toBe(false);
		expect(declarationOnDirectLine("src/retry.js-12- export async function withRetries(operation) {", declaration)).toBe(false);
		expect(declarationOnDirectLine("export async function withRetries(operation) {", declaration)).toBe(true);
	});

	it("keeps a live window open across a grep sighting of the declaration (synthetic)", () => {
		const entry = defect("retry-swallowed-failure");
		const payload = {
			input: [
				{ type: "function_call_output", output: "return { ok: true, attempts, response: null, note: x };" },
				{ type: "function_call_output", output: "src/retry.js:12: export async function withRetries(operation, {} = {}) {" },
			],
		};
		expect(defectStateInPayload(payload, entry)?.state).toBe("live");
	});

	it("still closes on a direct read-back of the repaired region (synthetic)", () => {
		const entry = defect("retry-swallowed-failure");
		const payload = {
			input: [
				{ type: "function_call_output", output: "return { ok: true, attempts, response: null, note: x };" },
				{ type: "function_call_output", output: "export async function withRetries(operation, {} = {}) {\n  // repaired body\n}" },
			],
		};
		expect(defectStateInPayload(payload, entry)?.state).toBe("fixed");
	});

	it("q15 dispatcher reproduction: the grep hit at input[79] no longer closes the window", () => {
		const state = defectStateInPayload(load("dispatcher-sol-high-a1-r2-q15.json"), defect("retry-swallowed-failure"));
		expect(state?.state).toBe("live");
	});

	it("q11 scheduler reproduction: the grep hit at input[60] no longer closes the window", () => {
		const state = defectStateInPayload(load("scheduler-sol-xhigh-a1-r1-q11.json"), defect("sched-claim-toctou"));
		expect(state?.state).toBe("live");
	});
});
