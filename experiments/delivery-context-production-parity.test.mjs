import { describe, expect, it } from "vitest";
import {
	buildJudgeObservationEnvelope,
	buildJudgeObservationPrompt,
	parseFooterDecision,
} from "./frozen-footer-protocol.mjs";
import {
	buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationEnvelope,
	buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationPrompt,
	parseUnifiedFooterDecision,
} from "./tool-free-protocol.mjs";

const productionState = {
	lastByThisHead: { delivery: "steer", message: "The redirect permits an external origin." },
	pending: [{ head: "security", delivery: "queue", message: "Check the related redirect variant." }],
};

const experimentalState = {
	lastSuccessfulForThisHead: {
		head: "security",
		delivery: productionState.lastByThisHead.delivery,
		message: productionState.lastByThisHead.message,
	},
	pendingAcrossHeads: productionState.pending,
};

describe("frozen footer protocol parity with the measured builders", () => {
	const correctLifecycleWording = (measured) =>
		measured.replace(
			"lastByThisHead is this head's most recent message that successfully reached the driver; it may be absent from this fork when the forked snapshot is older. pending messages have been accepted by the harness but have not reached the driver yet.",
			"lastByThisHead is this head's most recent delivery accepted by the runtime; depending on its route, it may have reached the user or durable session state rather than the driver, and it may be absent when this fork's snapshot is older. pending messages are held in a live Pi queue and have not reached the driver yet.",
		);

	it("promotes the measured split envelope with only the lifecycle wording corrected", () => {
		expect(buildJudgeObservationEnvelope("security", productionState)).toBe(
			correctLifecycleWording(
				buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationEnvelope("security", experimentalState),
			),
		);
	});

	it("promotes the measured combined prompt with only the lifecycle wording corrected", () => {
		expect(buildJudgeObservationPrompt("security", "Review security.", productionState)).toBe(
			correctLifecycleWording(
				buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationPrompt(
					"security",
					"Review security.",
					experimentalState,
				),
			),
		);
	});

	it("keeps the measured strict delivery footer", () => {
		for (const response of [
			"A concrete finding.\nDELIVERY: steer",
			"A user note.\nDELIVERY: print",
			"missing footer",
		]) {
			expect(parseFooterDecision(response)).toEqual(parseUnifiedFooterDecision(response));
		}
	});

	it("accepts an explicit none footer after private rationale", () => {
		expect(parseFooterDecision("The related feedback is pending.\nDELIVERY: none")).toEqual({
			decision: { action: "noop", reason: "observation completed", message: "" },
			error: null,
		});
	});

	it("rejects a routed footer without a message", () => {
		expect(parseFooterDecision("DELIVERY: steer")).toEqual({
			decision: null,
			error: "message must be non-empty",
		});
	});
});
