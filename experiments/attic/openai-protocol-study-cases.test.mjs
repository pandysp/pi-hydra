import { describe, expect, it } from "vitest";
import {
	OPENAI_PROTOCOL_STUDY_CASES,
	OPENAI_PROTOCOL_STUDY_CASES_HASH,
} from "./openai-protocol-study-cases.mjs";

describe("fresh OpenAI protocol-study case freeze", () => {
	it("seals the intended families before candidate wording exists", () => {
		expect(OPENAI_PROTOCOL_STUDY_CASES).toHaveLength(9);
		expect(OPENAI_PROTOCOL_STUDY_CASES_HASH).toMatch(/^[0-9a-f]{64}$/);
		expect(OPENAI_PROTOCOL_STUDY_CASES.filter((item) => item.family === "multi-finding")).toHaveLength(5);
		expect(OPENAI_PROTOCOL_STUDY_CASES.filter((item) => item.family === "quiet")).toHaveLength(1);
		expect(OPENAI_PROTOCOL_STUDY_CASES.filter((item) => item.family === "active-emergency")).toHaveLength(2);
		expect(OPENAI_PROTOCOL_STUDY_CASES.filter((item) => item.family === "proposed-danger")).toHaveLength(1);
	});

	it("keeps labels out of the producer-visible messages", () => {
		for (const item of OPENAI_PROTOCOL_STUDY_CASES) {
			const visible = JSON.stringify(item.messages);
			for (const expected of item.issues) {
				expect(visible).not.toContain(expected.id);
			}
		}
	});

	it("registers the semantic cost of deleting interrupt", () => {
		for (const item of OPENAI_PROTOCOL_STUDY_CASES) {
			if (item.family === "active-emergency") {
				expect(item.controlAction).toBe("interrupt");
				expect(item.noInterruptAction).toBe("steer");
			} else {
				expect(item.noInterruptAction).toBe(item.controlAction);
			}
		}
	});
});
