import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	assertFinalDataset,
	assertConsensusStateMatches,
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
		addition: {
			novel: { finalRound: 6, converged: 62, total: 67 },
			precision: { finalRound: 2, converged: 2, total: 2 },
			rejudge: { finalRound: 5, converged: 4, total: 5 },
		},
	},
});

function writeConsensus(stateRoot, directory, finalRound, converged, total) {
	const ids = Array.from({ length: total }, (_, index) => `${directory}-${index}`);
	write(join(stateRoot, directory, "consensus.json"), `${JSON.stringify({
		ids,
		rounds: { [finalRound]: { converged: ids.slice(0, converged), open: ids.slice(converged) } },
	})}\n`);
}

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

	it("accepts an adopted protocol decision whose terminated dissents close the gap exactly", () => {
		const decided = finalDataset();
		decided.builtFrom.consensus.novel.converged = 63;
		decided.builtFrom.addition.precision.converged = 1;
		decided.builtFrom.protocolDecision = {
			doc: "experiments/GOLDEN-V2-PROTOCOL-DECISION.md",
			option: "A",
			adopted: "ADOPTED: Option A — 2026-08-04 by Andreas",
			terminated: ["CL38", "V2-I02", "V2-I04", "V2-I05"],
			rawConvergence: "63/67",
		};
		expect(() => assertFinalDataset(decided)).not.toThrow();
		const dryRun = finalDataset();
		dryRun.builtFrom.consensus.novel.converged = 63;
		dryRun.builtFrom.addition.precision.converged = 1;
		dryRun.builtFrom.protocolDecision = { ...decided.builtFrom.protocolDecision, adopted: "DRY RUN — NOT ADOPTED, output is a projection" };
		expect(() => assertFinalDataset(dryRun)).toThrow(/adoption line/);
		const gapped = finalDataset();
		gapped.builtFrom.consensus.novel.converged = 62;
		gapped.builtFrom.protocolDecision = decided.builtFrom.protocolDecision;
		expect(() => assertFinalDataset(gapped)).toThrow(/close the novel convergence gap/);
	});

	it("requires the frozen consensus states to match the dataset's recorded final rounds", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "golden-v2-consensus-"));
		writeConsensus(stateRoot, "consensus-novel", 6, 62, 67);
		writeConsensus(stateRoot, "consensus-precision", 2, 2, 2);
		writeConsensus(stateRoot, "consensus-rejudge", 5, 4, 5);
		expect(() => assertConsensusStateMatches(finalDataset(), stateRoot)).not.toThrow();

		writeConsensus(stateRoot, "consensus-precision", 2, 1, 2);
		expect(() => assertConsensusStateMatches(finalDataset(), stateRoot)).toThrow(/records 2 converged but state has 1/);
	});
});
