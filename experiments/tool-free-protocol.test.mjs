import { describe, expect, it } from "vitest";
import {
	buildCompactLastPlusPendingUnifiedFooterObservationEnvelope,
	buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationEnvelope,
	buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationPrompt,
	buildFactualLastPlusPendingUnifiedFooterObservationEnvelope,
	buildFactualLastPlusPendingUnifiedFooterObservationPrompt,
	buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationEnvelope,
	buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationPrompt,
	buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationEnvelope,
	buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationPrompt,
	selectLastSuccessfulPlusPending,
} from "./tool-free-protocol.mjs";

const event = (head, delivery, message, status) => ({ head, delivery, message, status });

describe("selectLastSuccessfulPlusPending", () => {
	it("keeps only the last completed delivery for this head and all pending queue/steer deliveries", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "older", "delivered"),
				event("quality", "print", "other completed", "delivered"),
				event("security", "queue", "latest", "delivered"),
				event("quality", "queue", "queued across heads", "pending"),
				event("security", "steer", "steering from this head", "pending"),
			],
			"security",
		);

		expect(state).toEqual({
			lastSuccessfulForThisHead: { head: "security", delivery: "queue", message: "latest" },
			pendingAcrossHeads: [
				{ head: "quality", delivery: "queue", message: "queued across heads" },
				{ head: "security", delivery: "steer", message: "steering from this head" },
			],
		});
	});

	it("excludes failed, consumed, print, and interrupt entries from the pending pipeline", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "failed", "failed"),
				event("quality", "queue", "consumed", "consumed"),
				event("quality", "print", "not agent-bound", "pending"),
				event("quality", "interrupt", "not queued", "pending"),
			],
			"security",
		);

		expect(state).toEqual({ lastSuccessfulForThisHead: null, pendingAcrossHeads: [] });
	});

	it("rejects no-feedback and malformed records instead of treating them as deliveries", () => {
		expect(() =>
			selectLastSuccessfulPlusPending([event("security", "none", "", "delivered")], "security"),
		).toThrow("routed delivery");
		expect(() =>
			selectLastSuccessfulPlusPending([event("security", "steer", "finding", "unknown")], "security"),
		).toThrow("known status");
	});

	it("does not grow with completed delivery history", () => {
		const hundred = Array.from({ length: 100 }, (_, index) =>
			event("security", "steer", `finding ${index}`, "delivered"),
		);
		const state = selectLastSuccessfulPlusPending(hundred, "security");

		expect(state.lastSuccessfulForThisHead?.message).toBe("finding 99");
		expect(state.pendingAcrossHeads).toEqual([]);
		expect(JSON.stringify(state)).not.toContain("finding 98");
	});

	it("serializes the same state compactly without losing cross-head provenance", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "latest", "delivered"),
				event("quality", "queue", "still pending", "pending"),
			],
			"security",
		);
		const envelope = buildCompactLastPlusPendingUnifiedFooterObservationEnvelope("security", state);

		expect(envelope).toContain('"last":{"delivery":"steer","message":"latest"}');
		expect(envelope).toContain(
			'"pending":[{"head":"quality","delivery":"queue","message":"still pending"}]',
		);
		expect(envelope).not.toContain("lastSuccessfulForThisHead");
		expect(envelope).toContain("older successful deliveries are eligible again");
	});

	it("does not let visible trajectory history override the authoritative bounded state", () => {
		const state = selectLastSuccessfulPlusPending(
			[event("security", "steer", "latest", "delivered")],
			"security",
		);
		const envelope = buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationEnvelope(
			"security",
			state,
		);

		expect(envelope).toContain('"lastByThisHead":{"delivery":"steer","message":"latest"}');
		expect(envelope).toContain("Only listed records count as handled");
		expect(envelope).not.toContain("already visible since the latest ordinary user task");

		const prompt = buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationPrompt(
			"security",
			"Review trust boundaries.",
			state,
		);
		expect(prompt).toContain("LENS: Review trust boundaries.");
		expect(prompt).toContain("Only listed records count as handled");
		expect(prompt).not.toContain("already visible since the latest ordinary user task");
	});

	it("presents delivery state as facts while leaving repetition judgment to the lens", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "last delivery", "delivered"),
				event("quality", "queue", "on the way", "pending"),
			],
			"security",
		);
		const envelope = buildFactualLastPlusPendingUnifiedFooterObservationEnvelope("security", state);
		const prompt = buildFactualLastPlusPendingUnifiedFooterObservationPrompt(
			"security",
			"Review trust boundaries.",
			state,
		);

		for (const value of [envelope, prompt]) {
			expect(value).toContain("factual data, not a repetition policy");
			expect(value).toContain("the lens's own judgment");
			expect(value).toContain('"lastByThisHead":{"delivery":"steer","message":"last delivery"}');
			expect(value).toContain(
				'"pending":[{"head":"quality","delivery":"queue","message":"on the way"}]',
			);
			expect(value).not.toContain("discard candidates");
			expect(value).not.toContain("Only listed records count as handled");
			expect(value).not.toContain("already visible since the latest ordinary user task");
		}
	});

	it("can guide repetition judgment without converting considerations into suppression rules", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "verify signatures", "delivered"),
				event("quality", "queue", "report hook failures", "pending"),
			],
			"security",
		);
		const envelope = buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationEnvelope(
			"security",
			state,
		);
		const prompt = buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationPrompt(
			"security",
			"Review trust boundaries.",
			state,
		);

		for (const value of [envelope, prompt]) {
			expect(value).toContain("feedback would add value now");
			expect(value).toContain("driver ignored it or circumstances materially changed");
			expect(value).toContain("considerations, not suppression rules");
			expect(value).toContain("make the final judgment under the lens");
			expect(value).not.toContain("discard candidates");
			expect(value).not.toContain("Only listed records count as handled");
		}
	});

	it("can require evidence for repetition without suppressing unrelated findings", () => {
		const state = selectLastSuccessfulPlusPending(
			[
				event("security", "steer", "verify signatures", "delivered"),
				event("quality", "queue", "report hook failures", "pending"),
			],
			"security",
		);
		const envelope = buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationEnvelope(
			"security",
			state,
		);
		const prompt = buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationPrompt(
			"security",
			"Review trust boundaries.",
			state,
		);

		for (const value of [envelope, prompt]) {
			expect(value).toContain("unrelated pending feedback does not reduce its eligibility");
			expect(value).toContain("merely remaining unresolved is not evidence");
			expect(value).toContain("Explicit rejection or a material change supports a follow-up");
			expect(value).toContain("considerations, not suppression rules");
			expect(value).not.toContain("discard candidates");
		}
	});
});
