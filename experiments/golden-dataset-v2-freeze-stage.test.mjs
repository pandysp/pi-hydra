import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	assertFinalDataset,
	buildFreezeInputPlan,
	REPO_INPUTS,
	stageFreezeInputs,
	STATE_DIRS,
	STATE_INPUTS,
} from "./golden-dataset-v2-freeze-stage.mjs";

const write = (path, bytes = "x\n") => {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, bytes);
};

const finalDataset = () => ({
	version: "1234567890abcdef",
	issues: [{ tier: "blocking" }, { tier: "harmful" }],
	rejected: [{}],
	builtFrom: {
		consensus: { novel: { converged: 64, total: 67 } },
		addition: { precision: { converged: 2, total: 2 } },
	},
});

describe("golden v2 final freeze stage", () => {
	it("collects every registered input and preserves logical gzip bytes with hashes", () => {
		const root = mkdtempSync(join(tmpdir(), "golden-v2-freeze-"));
		const repo = join(root, "repo");
		const stateRoot = join(root, "state");
		for (const name of REPO_INPUTS) write(join(repo, name), name.endsWith(".gz") ? gzipSync("frame\n") : `${name}\n`);
		for (const name of STATE_INPUTS) write(join(stateRoot, name), `${name}\n`);
		for (const name of STATE_DIRS) write(join(stateRoot, name, "record.json"), `${name}\n`);
		const entries = buildFreezeInputPlan({ repo, stateRoot });
		const output = join(root, "stage");
		const provenance = stageFreezeInputs({
			entries,
			output,
			dataset: finalDataset(),
			codeCommit: "abc",
			checkerOutput: "golden dataset: 8/8 checks passed\n",
		});
		expect(provenance.files).toHaveLength(REPO_INPUTS.length + STATE_INPUTS.length + STATE_DIRS.length + 1);
		const frame = provenance.files.find((file) => file.source.endsWith("frame-sources.json.gz"));
		expect(readFileSync(join(output, frame.stagedName), "utf8")).toBe("frame\n");
		expect(provenance.dataset).toMatchObject({ version: "1234567890abcdef", active: 2, blocking: 1, rejected: 1 });
		expect(() => stageFreezeInputs({ entries, output, dataset: finalDataset(), codeCommit: "abc", checkerOutput: "8/8 checks passed" })).toThrow(/already exists/);
	});

	it("fails closed on provisional, below-threshold, or incomplete precision state", () => {
		const provisional = finalDataset();
		provisional.provisional = { reason: "open" };
		expect(() => assertFinalDataset(provisional)).toThrow(/provisional/);
		const below = finalDataset();
		below.builtFrom.consensus.novel.converged = 63;
		expect(() => assertFinalDataset(below)).toThrow(/95%/);
		const incomplete = finalDataset();
		incomplete.builtFrom.addition.precision.converged = 1;
		expect(() => assertFinalDataset(incomplete)).toThrow(/precision/);
	});
});
