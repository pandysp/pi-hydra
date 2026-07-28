import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAnthropicObservationPrompt, buildObservationEnvelope } from "../utils.ts";
import { GOLDEN_CASES, GOLDEN_HEADS, GOLDEN_SOURCES } from "./delivery-context-golden-cases.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function counts(field) {
	return Object.fromEntries(
		[...new Set(GOLDEN_CASES.map((item) => item[field]))]
			.sort()
			.map((value) => [value, GOLDEN_CASES.filter((item) => item[field] === value).length]),
	);
}

function frozenManifest() {
	return GOLDEN_CASES.map(
		({
			id,
			trajectory,
			head,
			state,
			expectedDelivery,
			expectedFinding,
			category,
			counterfactual,
			critical,
			messages,
		}) => ({
			id,
			trajectory,
			head,
			state,
			expectedDelivery,
			expectedFinding,
			category,
			counterfactual,
			critical,
			messages,
		}),
	);
}

describe("frozen delivery-context golden corpus", () => {
	it("contains exactly twelve cases from each of three real source trajectories", () => {
		expect(GOLDEN_CASES).toHaveLength(36);
		expect(counts("trajectory")).toEqual({ diagnostics: 12, login: 12, webhook: 12 });
		expect(Object.keys(GOLDEN_SOURCES).sort()).toEqual(["diagnostics", "login", "webhook"]);
		for (const source of Object.values(GOLDEN_SOURCES)) {
			expect(source.session).toMatch(/^[0-9a-f-]{36}$/);
			expect(source.messageIds.length).toBeGreaterThanOrEqual(8);
		}
	});

	it("covers the declared contexts and every delivery route", () => {
		expect(counts("expectedDelivery")).toEqual({ interrupt: 1, none: 14, print: 1, queue: 2, steer: 18 });
		const categories = new Set(GOLDEN_CASES.map((item) => item.category));
		for (const category of [
			"fresh",
			"pending-equivalent",
			"pending-unrelated",
			"newly-delivered-no-response",
			"visible-no-response",
			"explicit-rejection",
			"partial-resolution",
			"full-resolution",
			"material-change",
			"older-visible-rejection",
			"deferrable-follow-up",
			"user-only",
			"emergency",
		]) {
			expect(categories.has(category), `missing ${category}`).toBe(true);
		}
	});

	it("keeps compact trajectories provider-safe and delivery state bounded", () => {
		for (const testCase of GOLDEN_CASES) {
			expect(testCase.messages[0]?.role).toBe("user");
			for (let index = 1; index < testCase.messages.length; index++) {
				expect(testCase.messages[index].role).not.toBe(testCase.messages[index - 1].role);
			}
			expect(testCase.state.pending.every((item) => item.delivery === "queue" || item.delivery === "steer")).toBe(true);
			expect(testCase.state.lastByThisHead === null || typeof testCase.state.lastByThisHead.message === "string").toBe(true);
		}
	});

	it("freezes the complete semantic manifest", () => {
		expect(hash(JSON.stringify(frozenManifest()))).toBe(
			"f576ad4280f85bd5ca6671d64f5399c3d98ed81a42203bd7e1ce6af4008f4ac4",
		);
	});

	it("freezes the production control prompts independently of treatment work", () => {
		expect(hash(buildObservationEnvelope("security", []))).toBe(
			"c157243e3204a693f97d03000b93eb222295c93ed0fda7d13d57beac4f72ff66",
		);
		expect(hash(buildAnthropicObservationPrompt("security", GOLDEN_HEADS.security, []))).toBe(
			"c166245f1901848d8ebd12220cd965e0033faa01bc395d0bca080e31ccc89621",
		);
	});
});
