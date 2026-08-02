import { describe, expect, it } from "vitest";
import { stableJudgeHeader } from "./openai-protocol-study-judge.mjs";

describe("OpenAI protocol judge runner continuation", () => {
	it("permits runner-only provenance drift without weakening protocol identity", () => {
		const first = stableJudgeHeader({
			kind: "header",
			codeCommit: "old",
			codeDirty: null,
			ts: 1,
			judge: { id: "sol", batchSize: 8 },
			producerRowsSha256: "rows",
		});
		const resumed = stableJudgeHeader({
			kind: "header",
			codeCommit: "new",
			codeDirty: "dirty",
			ts: 2,
			judge: { id: "sol", batchSize: 8 },
			producerRowsSha256: "rows",
		});
		expect(resumed).toEqual(first);
		expect(stableJudgeHeader({ ...resumed, judge: { id: "sol", batchSize: 16 } })).not.toEqual(first);
	});
});
