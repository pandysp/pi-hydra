import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAnthropicObservationPrompt, buildObservationEnvelope } from "../utils.ts";
import { GOLDEN_CASES, GOLDEN_HEADS, GOLDEN_SOURCES } from "./delivery-context-golden-cases.mjs";
import {
	DRIVER_AWARE,
	DRIVER_INVISIBLE,
	deliveryBucket,
	implementationArm,
	isDeliveryBucketCorrect,
	sameHeadDeliveryContext,
} from "./delivery-context-evaluation.mjs";
import { buildJudgePrompt, parseBinaryJudgments } from "./delivery-context-judge-protocol.mjs";

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
				findingTarget,
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
				findingTarget,
			category,
			counterfactual,
			critical,
			messages,
		}),
	);
}

describe("frozen delivery-context golden corpus", () => {
	it("contains 41 cases derived from three real source trajectories", () => {
		expect(GOLDEN_CASES).toHaveLength(41);
		expect(counts("trajectory")).toEqual({ diagnostics: 13, login: 12, webhook: 16 });
		expect(Object.keys(GOLDEN_SOURCES).sort()).toEqual(["diagnostics", "login", "webhook"]);
		for (const source of Object.values(GOLDEN_SOURCES)) {
			expect(source.session).toMatch(/^[0-9a-f-]{36}$/);
			expect(source.messageIds.length).toBeGreaterThanOrEqual(8);
		}
	});

	it("covers the declared contexts and every delivery route", () => {
		expect(counts("expectedDelivery")).toEqual({ interrupt: 2, none: 14, print: 3, queue: 3, steer: 19 });
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

	it("uses the frozen two-bucket delivery contract", () => {
		expect(deliveryBucket("none")).toBe(DRIVER_INVISIBLE);
		expect(deliveryBucket("print")).toBe(DRIVER_INVISIBLE);
		for (const delivery of ["queue", "steer", "interrupt"]) {
			expect(deliveryBucket(delivery)).toBe(DRIVER_AWARE);
		}
		expect(isDeliveryBucketCorrect(null, "steer")).toBe(false);
	});

	it("maps C to production same-head context and withholds sibling pending state", () => {
		expect(implementationArm("C")).toBe("samehead");
		expect(
			sameHeadDeliveryContext(
				{
					lastByThisHead: null,
					pending: [
						{ head: "security", delivery: "steer", message: "same head" },
						{ head: "quality", delivery: "queue", message: "sibling" },
					],
				},
				"security",
			),
		).toEqual({
			lastByThisHead: null,
			pending: [{ head: "security", delivery: "steer", message: "same head" }],
		});
	});

	it("keeps compact trajectories provider-safe and delivery state bounded", () => {
		for (const testCase of GOLDEN_CASES) {
			expect(testCase.messages[0]?.role).toBe("user");
			for (let index = 1; index < testCase.messages.length; index++) {
				expect(testCase.messages[index].role).not.toBe(testCase.messages[index - 1].role);
			}
				expect(testCase.state.pending.every((item) => item.delivery === "queue" || item.delivery === "steer")).toBe(true);
				expect(testCase.state.lastByThisHead === null || typeof testCase.state.lastByThisHead.message === "string").toBe(true);
				expect(testCase.expectedFinding === "none" ? testCase.findingTarget : typeof testCase.findingTarget).toBe(
					testCase.expectedFinding === "none" ? null : "string",
				);
			}
		});

	it("includes semantic rather than byte-identical repeat coverage", () => {
		const unseen = GOLDEN_CASES.find((item) => item.id === "webhook-security-last-unseen");
		const pending = GOLDEN_CASES.find((item) => item.id === "webhook-security-pending-equivalent");
		expect(unseen.state.lastByThisHead.message).not.toBe(pending.state.pending[0].message);
		expect(unseen.expectedDelivery).toBe("none");
	});

	it("keeps narrow judge prompts blind to unrelated gold labels", () => {
		const testCase = GOLDEN_CASES.find((item) => item.id === "webhook-security-fresh");
		const supportPrompt = buildJudgePrompt("support", [{ testCase, message: "Verify the webhook signature." }]);
		const targetPrompt = buildJudgePrompt("target", [{ testCase, message: "Verify the webhook signature." }]);
		for (const prompt of [supportPrompt, targetPrompt]) {
			expect(prompt).not.toContain("Expected delivery:");
			expect(prompt).not.toContain("Category:");
			expect(prompt).not.toContain("Critical:");
			expect(prompt).not.toContain("Actual delivery:");
		}
		expect(supportPrompt).not.toContain(testCase.findingTarget);
		expect(targetPrompt).toContain(testCase.findingTarget);
	});

	it("requires binary judge answers with reasoning", () => {
		expect(parseBinaryJudgments('{"cases":[{"id":"j01","reasoning":"Visible in code.","answer":true}]}', 1)).toEqual([
			{ id: "j01", reasoning: "Visible in code.", answer: true },
		]);
		expect(parseBinaryJudgments('{"cases":[{"id":"j01","answer":true}]}', 1)).toBeNull();
	});

	it("freezes the complete semantic manifest", () => {
		expect(hash(JSON.stringify(frozenManifest()))).toBe(
			"8dcf719754b23296ee8333bd868107841d43f135ce8e47f5498505195d228773",
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
