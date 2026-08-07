import { describe, expect, it } from "vitest";
import { anchorResolution, sessionEndpoints } from "./golden-dataset-frame-sources.mjs";
import { frameOf } from "./golden-dataset-pool.mjs";

const frames = {
	tasks: {
		exporter: {
			seed: { files: { "src/a.js": "const size = Number(limit);" } },
			session: {
				start: { files: { "src/a.js": "const size = Number(limit);" } },
				end: { files: { "src/a.js": "const size = parseInt(limit);", "test/a.test.js": "import { size } from '../src/a.js';" } },
			},
		},
	},
};

describe("golden dataset frame anchors", () => {
	it("selects the stated file, endpoint, and match semantics", () => {
		expect(anchorResolution({
			id: "EXP-seed", task: "exporter", frame: "seed",
			anchors: { file: "src/a.js", state: "seed", match: "regex", expression: "Number\\(limit\\)" },
		}, frames)).toEqual({ ok: true });
		expect(anchorResolution({
			id: "EXP-end", task: "exporter", frame: "session",
			anchors: { file: "src/a.js", state: "end", match: "literal", expression: "parseInt(limit)" },
		}, frames)).toEqual({ ok: true });
	});

	it("checks negative source facts in the selected endpoint", () => {
		expect(anchorResolution({
			id: "EXP-gap", task: "exporter", frame: "session",
			anchors: {
				file: "test/a.test.js", state: "end", match: "literal",
				expression: "import { size }", absent: ["describePagination"],
			},
		}, frames)).toEqual({ ok: true });
	});

	it("rejects an expression that exists only in the wrong endpoint", () => {
		expect(anchorResolution({
			id: "EXP-wrong-end", task: "exporter", frame: "session",
			anchors: { file: "src/a.js", state: "end", match: "literal", expression: "Number(limit)" },
		}, frames)).toEqual({ ok: false, reason: "literal expression does not resolve in src/a.js" });
	});

	it("takes the first and last file-state records, not row order", () => {
		const endpoints = sessionEndpoints([
			{ kind: "file-state", pointIndex: 3, pointId: "end", files: { a: "end" } },
			{ kind: "observation", pointIndex: 2 },
			{ kind: "file-state", pointIndex: 0, pointId: "start", files: { a: "start" } },
		]);
		expect(endpoints.start.pointId).toBe("start");
		expect(endpoints.end.pointId).toBe("end");
	});
});

describe("RULE-ANCHOR-V2 anchor forms", () => {
	it("resolves a session-frame record's seed-state anchor against the seed", () => {
		expect(anchorResolution({
			id: "EXP-session-seed", task: "exporter", frame: "session",
			anchors: { file: "src/a.js", state: "seed", match: "literal", expression: "Number(limit)", absent: ["parseInt("] },
		}, frames)).toEqual({ ok: true });
	});

	it("resolves an emergent anchor against the session end state", () => {
		expect(anchorResolution({
			id: "EXP-emergent", task: "exporter", frame: "session",
			anchors: { file: "src/a.js", state: "emergent", match: "regex", expression: "parseInt\\(limit\\)" },
		}, frames)).toEqual({ ok: true });
		expect(anchorResolution({
			id: "EXP-emergent-miss", task: "exporter", frame: "session",
			anchors: { file: "src/a.js", state: "emergent", match: "regex", expression: "Number\\(limit\\)" },
		}, frames)).toEqual({ ok: false, reason: "regex expression does not resolve in src/a.js" });
	});

	it("resolves a two-sided anchor only when both byte predicates hold", () => {
		const anchors = {
			match: "two-sided", state: "emergent",
			code: { file: "src/a.js", present: "parseInt\\(limit\\)" },
			doc: { file: "test/a.test.js", contradicts: "import \\{ size \\}", absent: ["describePagination"] },
		};
		expect(anchorResolution({ id: "EXP-two-sided", task: "exporter", frame: "session", anchors }, frames))
			.toEqual({ ok: true });
		expect(anchorResolution({
			id: "EXP-two-sided-doc-gone", task: "exporter", frame: "session",
			anchors: { ...anchors, doc: { ...anchors.doc, contradicts: "header only" } },
		}, frames)).toEqual({ ok: false, reason: "doc: header only does not match test/a.test.js" });
		expect(anchorResolution({
			id: "EXP-two-sided-empty", task: "exporter", frame: "session",
			anchors: { ...anchors, code: { file: "src/a.js" } },
		}, frames)).toEqual({ ok: false, reason: "code: side asserts nothing" });
		expect(anchorResolution({
			id: "EXP-two-sided-half", task: "exporter", frame: "session",
			anchors: { match: "two-sided", state: "emergent", code: anchors.code },
		}, frames)).toEqual({ ok: false, reason: "two-sided anchor requires code and doc sides" });
	});
});

describe("v2 candidate frame provenance", () => {
	it("routes cross-task observer findings to their recorded session unless explicitly seeded", () => {
		expect(frameOf("observer", { task: "exporter", seeded: false })).toBe("session");
		expect(frameOf("observer", { task: "dispatcher", seeded: false })).toBe("session");
		expect(frameOf("observer", { task: "exporter", seeded: true })).toBe("seed");
	});

	it("keeps seed-only reviews and byte-identical cross-task code review on seed", () => {
		expect(frameOf("reference-review", { task: "dispatcher" })).toBe("seed");
		expect(frameOf("code-review", { task: "exporter" })).toBe("seed");
		expect(frameOf("code-review", { task: "scheduler" })).toBe("session");
	});
});
