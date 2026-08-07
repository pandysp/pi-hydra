/**
 * Behavior of the frozen pre-ENUM judge protocols, moved verbatim out of
 * `utils.test.ts` when the builders left the product tree. Byte-identity with
 * the recorded studies is pinned separately: by hash in
 * `delivery-context-golden.test.mjs` and against the measured experimental
 * builders in `delivery-context-production-parity.test.mjs`.
 */

import { describe, expect, it } from "vitest";
import {
	buildJudgeObservationEnvelope,
	buildJudgeObservationPrompt,
	buildLegacyAnthropicJudgePrompt,
	footerFormatCorrection,
	parseFooterDecision,
} from "./frozen-footer-protocol.mjs";

describe("frozen tool-free judge completion", () => {
	const context = {
		lastByThisHead: { delivery: "steer", message: "Fix the redirect." },
		pending: [{ head: "quality", delivery: "queue", message: "Cover the adjacent mutation bug." }],
	};

	it("keeps the lens out of the split envelope and supplies factual bounded state", () => {
		const envelope = buildJudgeObservationEnvelope("security", context);
		expect(envelope).toContain("preceding user message is the complete security lens");
		expect(envelope).toContain(JSON.stringify(context));
		expect(envelope).toContain("factual data, not a repetition policy");
		expect(envelope).toContain("These are considerations, not suppression rules");
		expect(envelope).not.toContain("Fix security issues.");
		expect(envelope).not.toContain("LENS:");
		expect(envelope).not.toContain("complete_observation");
	});

	it("has a combined-user analogue with the same factual state", () => {
		const prompt = buildJudgeObservationPrompt("security", "Fix security issues.", context);
		expect(prompt).toContain("LENS: Fix security issues.");
		expect(prompt).toContain(JSON.stringify(context));
		expect(prompt).toContain("DELIVERY: none");
	});

	it("strictly parses none and natural findings with one exact footer", () => {
		expect(parseFooterDecision(" DELIVERY: none\n")).toEqual({
			decision: { action: "noop", reason: "observation completed", message: "" },
			error: null,
		});
		expect(parseFooterDecision("The redirect permits an external origin.\nDELIVERY: steer")).toEqual({
			decision: {
				action: "steer",
				reason: "observation completed",
				message: "The redirect permits an external origin.",
			},
			error: null,
		});
		expect(parseFooterDecision("The redirect permits an external origin. DELIVERY: steer")).toEqual({
			decision: {
				action: "steer",
				reason: "observation completed",
				message: "The redirect permits an external origin.",
			},
			error: null,
		});
		expect(parseFooterDecision("DELIVERY: steer")).toMatchObject({
			decision: null,
			error: "message must be non-empty",
		});
		expect(parseFooterDecision("The issue is already pending.\nDELIVERY: none")).toEqual({
			decision: { action: "noop", reason: "observation completed", message: "" },
			error: null,
		});
		expect(parseFooterDecision("DELIVERY: none\n\nThe issue is already pending.")).toEqual({
			decision: { action: "noop", reason: "observation completed", message: "" },
			error: null,
		});
		expect(parseFooterDecision("DELIVERY: none\nDELIVERY: steer")).toMatchObject({
			decision: null,
			error: "feedback contains multiple DELIVERY markers",
		});
		expect(parseFooterDecision("finding\nDELIVERY: STEER")).toMatchObject({ decision: null });
	});

	it("keeps recovery format-only while making cached driver tools explicitly unavailable", () => {
		const correction = footerFormatCorrection("missing footer");
		expect(correction).toContain("Preserve its semantic decision and finding");
		expect(correction).toContain("cached driver request");
		expect(correction).toContain("unavailable to this observation");
		expect(correction).toContain("DELIVERY: print|queue|steer|interrupt");
	});
});

describe("frozen Anthropic judge control", () => {
	it("keeps the pre-ENUM judge control in one JSON response", () => {
		const prompt = buildLegacyAnthropicJudgePrompt("quality", "Judge.");
		expect(prompt).toContain("one JSON object");
		expect(prompt).toContain('"action":"noop|print|queue|steer|interrupt"');
		expect(prompt).toContain("You have no work tools");
		expect(prompt).not.toContain('action "complete_observation"');
	});
});
