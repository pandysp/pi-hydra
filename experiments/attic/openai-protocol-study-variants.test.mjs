import { describe, expect, it } from "vitest";
import { buildEnumeratedJudgeObservationEnvelope } from "../../utils.ts";
import {
	CONTROL_ENVELOPE,
	EMPTY_DELIVERY_CONTEXT,
	NO_INTERRUPT_ENVELOPE,
	OPENAI_PROTOCOL_STUDY_ARMS,
	STUDY_HEAD,
	TERSE_ENVELOPE,
	TERSE_NO_INTERRUPT_ENVELOPE,
	noInterruptEnvelope,
	parseStudyResponse,
	terseEnvelope,
} from "./openai-protocol-study-variants.mjs";

describe("OpenAI protocol-study variants", () => {
	it("pins the control byte-for-byte to the shipped ENUM-SO2 envelope", () => {
		expect(CONTROL_ENVELOPE).toBe(buildEnumeratedJudgeObservationEnvelope(STUDY_HEAD, EMPTY_DELIVERY_CONTEXT));
	});

	it("composes two independent edits", () => {
		expect(TERSE_ENVELOPE).toBe(terseEnvelope(CONTROL_ENVELOPE));
		expect(NO_INTERRUPT_ENVELOPE).toBe(noInterruptEnvelope(CONTROL_ENVELOPE));
		expect(TERSE_NO_INTERRUPT_ENVELOPE).toBe(noInterruptEnvelope(TERSE_ENVELOPE));
		expect(new Set(Object.values(OPENAI_PROTOCOL_STUDY_ARMS).map((arm) => arm.envelope)).size).toBe(4);
	});

	it("rejects interrupt from the deleted vocabulary and records cap compliance", () => {
		const invalid = parseStudyResponse(
			"ENUM-SO2-NOINT",
			JSON.stringify({ findings: [{ action: "interrupt", reason: "urgent", message: "stop" }] }),
		);
		expect(invalid.findings).toBeNull();

		const overlong = parseStudyResponse(
			"ENUM-SO2-TERSE",
			JSON.stringify({ findings: [{ action: "steer", reason: "r".repeat(81), message: "m" }] }),
		);
		expect(overlong.error).toBeNull();
		expect(overlong.capsValid).toBe(false);
	});
});
