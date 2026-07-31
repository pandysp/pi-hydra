import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEVELOPMENT_CASES } from "./delivery-context-development-cases.mjs";
import { GOLDEN_CASES, GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import { SCREEN_CASES } from "./delivery-context-screen-cases.mjs";
import { buildJudgePrompt } from "./delivery-context-judge-protocol.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function counts(field) {
	return Object.fromEntries(
		[...new Set(SCREEN_CASES.map((item) => item[field]))]
			.sort()
			.map((value) => [value, SCREEN_CASES.filter((item) => item[field] === value).length]),
	);
}

/** Same key shape and emission order as delivery-context-golden.test.mjs:25-53. */
function frozenManifest() {
	return SCREEN_CASES.map(
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

/** Mirrors priorExactDeliveries() in delivery-context-golden-ab.mjs:353-358. */
function visibleDeliveries(testCase) {
	const values = new Set();
	for (const message of testCase.messages) {
		if (message.role !== "user") continue;
		const match = message.text.match(/^\[([^\]]+)\]\s+([\s\S]+)$/);
		if (match) values.add(`${match[1]}|${match[2].trim()}`);
	}
	return values;
}

function recordedDeliveries(testCase) {
	const values = new Set();
	if (testCase.state.lastByThisHead) {
		values.add(`${testCase.head}|${testCase.state.lastByThisHead.message}`);
	}
	for (const item of testCase.state.pending) values.add(`${item.head}|${item.message}`);
	return values;
}

describe("fresh delivery-context screen corpus", () => {
	it("contains 12 authored cases in a domain no golden trajectory uses", () => {
		expect(SCREEN_CASES).toHaveLength(12);
		expect(counts("trajectory")).toEqual({ "screen-synthetic": 12 });
		// The judge resolves cases from all three corpora through one id map, so a
		// shadowed id would silently judge a screen row against another fixture.
		const otherIds = new Set([...GOLDEN_CASES, ...DEVELOPMENT_CASES].map((item) => item.id));
		for (const testCase of SCREEN_CASES) expect(otherIds.has(testCase.id), testCase.id).toBe(false);
	});

	it("covers the required categories and every delivery route with a steer-heavy skew", () => {
		const categories = new Set(SCREEN_CASES.map((item) => item.category));
		for (const category of [
			"fresh",
			"pending-equivalent",
			"explicit-rejection",
			"newly-delivered-no-response",
			"material-change",
			"user-only",
			"deferrable-follow-up",
			"emergency",
			"visible-no-response",
			"full-resolution",
		]) {
			expect(categories.has(category), `missing ${category}`).toBe(true);
		}
		expect(counts("expectedDelivery")).toEqual({ interrupt: 1, none: 4, print: 1, queue: 1, steer: 5 });
	});

	it("reuses the two frozen generic lenses, which name no defect", () => {
		expect(new Set(SCREEN_CASES.map((item) => item.head))).toEqual(new Set(["security", "quality"]));
		for (const head of ["security", "quality"]) {
			const lens = GOLDEN_HEADS[head];
			expect(typeof lens).toBe("string");
			expect(lens).not.toMatch(/forwarded|fallback|evict|rounding|staging|in-process|window|limiter/i);
		}
	});

	it("carries no ledger dependency: recorded state mirrors the visible trajectory exactly", () => {
		for (const testCase of SCREEN_CASES) {
			expect(recordedDeliveries(testCase), testCase.id).toEqual(visibleDeliveries(testCase));
		}
		const withPriorDelivery = SCREEN_CASES.filter((item) => visibleDeliveries(item).size > 0);
		expect(withPriorDelivery.length).toBe(7);
	});

	it("keeps trajectories provider-safe and delivery state bounded", () => {
		for (const testCase of SCREEN_CASES) {
			expect(testCase.messages[0]?.role).toBe("user");
			for (let index = 1; index < testCase.messages.length; index++) {
				expect(testCase.messages[index].role).not.toBe(testCase.messages[index - 1].role);
			}
			expect(testCase.state.pending.every((item) => item.delivery === "queue" || item.delivery === "steer")).toBe(true);
			expect(testCase.state.lastByThisHead === null || typeof testCase.state.lastByThisHead.message === "string").toBe(
				true,
			);
			expect(testCase.expectedFinding === "none" ? testCase.findingTarget : typeof testCase.findingTarget).toBe(
				testCase.expectedFinding === "none" ? null : "string",
			);
			expect(testCase.expectedFinding === "none").toBe(testCase.expectedDelivery === "none");
		}
	});

	it("keeps narrow judge prompts blind to the gold label", () => {
		const testCase = SCREEN_CASES.find((item) => item.id === "screen-security-fresh-forwarded-key");
		const items = [{ testCase, message: "Key the limit on the connection address." }];
		const supportPrompt = buildJudgePrompt("support", items);
		const targetPrompt = buildJudgePrompt("target", items);
		for (const prompt of [supportPrompt, targetPrompt]) {
			expect(prompt).not.toContain("Expected delivery:");
			expect(prompt).not.toContain("Category:");
			expect(prompt).not.toContain("Critical:");
		}
		expect(supportPrompt).not.toContain(testCase.findingTarget);
		expect(targetPrompt).toContain(testCase.findingTarget);
	});

	it("freezes the complete semantic manifest", () => {
		expect(hash(JSON.stringify(frozenManifest()))).toBe(
			"8262d4f639836c0cbffd87608c95e8c6028552aadc6539a752d724329d0d47e6",
		);
	});
});
