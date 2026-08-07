import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseEnumeratedDecision } from "../utils.ts";

const ARTIFACTS = [
	new URL("./artifacts/2026-08-02-steer-only/so2-high.jsonl.gz", import.meta.url),
	new URL("./artifacts/2026-08-02-steer-only/so2-xhigh.jsonl.gz", import.meta.url),
];

function measuredEnumSo2Rows() {
	return ARTIFACTS.flatMap((path) =>
		gunzipSync(readFileSync(path))
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((row) => row.kind === "skip-probe" && row.variantId === "ENUM-SO2" && !row.error),
	);
}

function expectedBatch(action, findings) {
	return {
		action,
		reason: findings
			.map((finding) => (typeof finding.reason === "string" ? finding.reason.slice(0, 200) : ""))
			.filter(Boolean)
			.join(" | "),
		message: findings.map((finding) => finding.message.trim().slice(0, 500)).join(" | "),
	};
}

describe("production routing of measured ENUM-SO2 responses", () => {
	it("preserves every measured message exactly once and separates all mixed recipients", () => {
		const rows = measuredEnumSo2Rows();
		expect(rows).toHaveLength(20);
		let mixed = 0;

		for (const row of rows) {
			const raw = JSON.parse(row.responseText);
			const prints = raw.findings.filter((finding) => finding.action === "print");
			const agent = raw.findings.filter(
				(finding) => finding.action === "steer" || finding.action === "interrupt",
			);
			const expected = [];
			if (prints.length > 0) expected.push(expectedBatch("print", prints));
			if (agent.length > 0) {
				expected.push(expectedBatch(agent.some((finding) => finding.action === "interrupt") ? "interrupt" : "steer", agent));
			}
			if (prints.length > 0 && agent.length > 0) mixed++;

			expect(parseEnumeratedDecision(row.responseText), row.pointId).toEqual({ decisions: expected, error: null });
		}

		expect(mixed).toBe(7);
	});
});
