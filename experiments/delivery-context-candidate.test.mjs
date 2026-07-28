import { describe, expect, it } from "vitest";
import {
	buildStructuredCandidateObservationEnvelope,
	buildStructuredContextObservationEnvelope,
	buildStructuredContextObservationPrompt,
	parseStructuredCandidateDecision,
	parseStructuredContextDecision,
} from "./delivery-context-candidate.mjs";

const context = {
	lastByThisHead: { delivery: "steer", message: "Parameterize the query." },
	pending: [{ head: "quality", delivery: "queue", message: "Add tests." }],
};

describe("structured context candidate", () => {
	it("keeps the lens outside the split envelope and includes factual state", () => {
		const value = buildStructuredContextObservationEnvelope("security", context);
		expect(value).toContain(JSON.stringify(context));
		expect(value).not.toContain("Parameterize every query in the lens");
		expect(value).not.toContain("gpt-");
	});

	it("uses the same contract in the combined-user prompt", () => {
		const value = buildStructuredContextObservationPrompt("security", "Parameterize every query in the lens.", context);
		expect(value).toContain("LENS: Parameterize every query in the lens.");
		expect(value).toContain(JSON.stringify(context));
	});

	it("parses new and follow-up findings", () => {
		expect(parseStructuredContextDecision("Parameterize email.\nCONTEXT: new\nDELIVERY: steer")).toMatchObject({
			decision: { action: "steer", message: "Parameterize email." },
			relation: "new",
			error: null,
		});
		expect(parseStructuredContextDecision("The driver rejected the fix.\nCONTEXT: follow_up\nDELIVERY: steer")).toMatchObject({
			decision: { action: "steer" },
			relation: "follow_up",
			error: null,
		});
	});

	it("accepts silent relations and ignores private rationale", () => {
		for (const relation of ["none", "waiting", "resolved"]) {
			expect(parseStructuredContextDecision(`Private rationale.\nCONTEXT: ${relation}\nDELIVERY: none`)).toMatchObject({
				decision: { action: "noop", message: "" },
				relation,
				error: null,
			});
		}
	});

	it("rejects inconsistent or incomplete contracts", () => {
		expect(parseStructuredContextDecision("CONTEXT: waiting\nDELIVERY: steer")).toMatchObject({ decision: null });
		expect(parseStructuredContextDecision("CONTEXT: new\nDELIVERY: none")).toMatchObject({ decision: null });
		expect(parseStructuredContextDecision("CONTEXT: new\nDELIVERY: steer")).toMatchObject({ decision: null });
		expect(parseStructuredContextDecision("finding\nDELIVERY: steer")).toMatchObject({ decision: null });
	});

	it("forces version 2 to identify a candidate before classifying it", () => {
		const value = buildStructuredCandidateObservationEnvelope("quality", context);
		expect(value).toContain("CANDIDATE: none|<one concise finding>");
		expect(
			parseStructuredCandidateDecision(
				"CANDIDATE: rows.sort mutates caller state\nRELATION: covered_no_response\nDELIVERY: none",
			),
		).toMatchObject({
			decision: { action: "noop", message: "" },
			candidate: "rows.sort mutates caller state",
			relation: "covered_no_response",
			error: null,
		});
	});

	it("uses the version 2 candidate as the routed message", () => {
		expect(
			parseStructuredCandidateDecision(
				"CANDIDATE: Parameterize the public reset lookup.\nRELATION: follow_up\nDELIVERY: steer",
			),
		).toMatchObject({
			decision: { action: "steer", message: "Parameterize the public reset lookup." },
			candidate: "Parameterize the public reset lookup.",
			relation: "follow_up",
			error: null,
		});
	});

	it("rejects inconsistent version 2 candidate relations", () => {
		expect(
			parseStructuredCandidateDecision("CANDIDATE: none\nRELATION: new\nDELIVERY: steer"),
		).toMatchObject({ decision: null });
		expect(
			parseStructuredCandidateDecision("CANDIDATE: A defect\nRELATION: none\nDELIVERY: none"),
		).toMatchObject({ decision: null });
		expect(
			parseStructuredCandidateDecision("CANDIDATE: A defect\nRELATION: resolved\nDELIVERY: steer"),
		).toMatchObject({ decision: null });
	});
});
