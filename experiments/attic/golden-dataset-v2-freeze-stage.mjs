#!/usr/bin/env node
/** Build the complete, flat, hash-addressed source directory for the final v2 freeze. */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { argOf } from "../lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = resolve(HERE, "..");

export const REPO_INPUTS = Object.freeze([
	"experiments/golden-dataset.json",
	"experiments/golden-dataset-v2-build.mjs",
	"experiments/golden-dataset-assemble.mjs",
	"experiments/golden-dataset-consensus.mjs",
	"experiments/golden-dataset-pool.mjs",
	"experiments/golden-dataset.check.mjs",
	"experiments/trajectory-cost-tasks.mjs",
	"experiments/GOLDEN-DATASET-V2-SPEC.md",
	"experiments/GOLDEN-DATASET-V2-RESULTS.md",
	"experiments/GOLDEN-V2-PROTOCOL-DECISION.md",
	"experiments/artifacts/2026-08-02-golden-dataset-v2/frame-sources.json.gz",
]);

export const STATE_INPUTS = Object.freeze([
	"anchor-material.json",
	"audit-v1.json",
	"blind-review-dispatcher.json",
	"blind-review-exporter.json",
	"edits-v2.json",
]);

export const STATE_DIRS = Object.freeze([
	"calibration",
	"pool",
	"consensus-novel",
	"consensus-rejudge",
	"consensus-precision",
	"consensus-editorial",
	"consensus-ruling4",
]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const logicalBytes = (path) => path.endsWith(".gz") ? gunzipSync(readFileSync(path)) : readFileSync(path);
const safeName = (rootName, path, root) => `${rootName}--${relative(root, path).split("/").join("--")}`.replace(/\.gz$/, "");

function filesUnder(path) {
	return readdirSync(path, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			const child = join(path, entry.name);
			return entry.isDirectory() ? filesUnder(child) : [child];
		});
}

export function buildFreezeInputPlan({ repo, stateRoot }) {
	const missing = [];
	const entries = [];
	for (const name of REPO_INPUTS) {
		const path = join(repo, name);
		if (!existsSync(path)) missing.push(`repo/${name}`);
		else entries.push({ source: `repo/${name}`, path, stagedName: safeName("repo", path, repo) });
	}
	for (const name of STATE_INPUTS) {
		const path = join(stateRoot, name);
		if (!existsSync(path)) missing.push(`state/${name}`);
		else entries.push({ source: `state/${name}`, path, stagedName: safeName("state", path, stateRoot) });
	}
	for (const name of STATE_DIRS) {
		const path = join(stateRoot, name);
		if (!existsSync(path)) {
			missing.push(`state/${name}/`);
			continue;
		}
		for (const child of filesUnder(path)) {
			entries.push({ source: `state/${relative(stateRoot, child)}`, path: child, stagedName: safeName("state", child, stateRoot) });
		}
	}
	if (missing.length > 0) throw new Error(`freeze inputs are incomplete:\n${missing.join("\n")}`);
	const names = entries.map((entry) => entry.stagedName);
	if (new Set(names).size !== names.length) throw new Error("freeze-stage filename collision");
	return entries.sort((a, b) => a.source.localeCompare(b.source));
}

export function assertFinalDataset(dataset) {
	if (dataset.provisional) throw new Error("refusing to freeze a provisional dataset");
	if (!/^[0-9a-f]{16}$/.test(dataset.version ?? "")) throw new Error("dataset has no valid content version");
	const novel = dataset.builtFrom?.consensus?.novel;
	if (!novel) throw new Error("dataset carries no novel consensus record");
	const decision = dataset.builtFrom?.protocolDecision;
	const precision = dataset.builtFrom?.addition?.precision;
	if (decision) {
		// GOLDEN-V2-PROTOCOL-DECISION.md Option A: terminated stable dissents
		// count as addressed; the gap they close must be exact.
		if (decision.option !== "A") throw new Error(`unknown protocol decision option ${decision.option}`);
		if (!/^ADOPTED: Option A\b/.test(decision.adopted ?? "")) throw new Error("protocol decision carries no adoption line — a dry-run projection is not freezable");
		const terminated = decision.terminated ?? [];
		if (novel.converged + terminated.length !== novel.total) throw new Error("terminated dissents do not close the novel convergence gap");
		const terminatedPrecision = terminated.filter((id) => /^CL/.test(id)).length;
		if (precision?.total !== 2 || precision.converged + terminatedPrecision !== 2) {
			throw new Error("precision repairs neither converged nor terminated under the adopted decision");
		}
	} else {
		if (novel.converged / novel.total < 0.95) throw new Error("dataset is below the registered 95% novel-consensus threshold and carries no adopted protocol decision");
		if (precision?.total !== 2 || precision.converged !== 2) {
			throw new Error("both precision repairs must converge before freeze");
		}
	}
}

export function assertConsensusStateMatches(dataset, stateRoot) {
	const addition = dataset.builtFrom?.addition;
	for (const [key, directory] of [
		["novel", "consensus-novel"],
		["precision", "consensus-precision"],
		["rejudge", "consensus-rejudge"],
	]) {
		const expected = addition?.[key];
		if (!expected) throw new Error(`dataset is missing builtFrom.addition.${key}`);
		const path = join(stateRoot, directory, "consensus.json");
		if (!existsSync(path)) throw new Error(`${directory}/consensus.json is missing`);
		const state = JSON.parse(readFileSync(path, "utf8"));
		const round = state.rounds?.[expected.finalRound];
		if (!round) throw new Error(`${directory}: final round ${expected.finalRound} is absent`);
		if (state.ids?.length !== expected.total) {
			throw new Error(`${directory}: dataset records ${expected.total} questions but state has ${state.ids?.length ?? "none"}`);
		}
		if (round.converged?.length !== expected.converged) {
			throw new Error(`${directory}: dataset records ${expected.converged} converged but state has ${round.converged?.length ?? "none"}`);
		}
		const terminal = [...(round.converged ?? []), ...(round.open ?? [])].sort();
		if (JSON.stringify(terminal) !== JSON.stringify([...state.ids].sort())) {
			throw new Error(`${directory}: final converged/open partition does not cover the registered ids exactly`);
		}
	}
}

export function stageFreezeInputs({ entries, output, dataset, codeCommit, checkerOutput }) {
	assertFinalDataset(dataset);
	if (existsSync(output)) throw new Error(`freeze stage already exists: ${output}`);
	mkdirSync(output, { recursive: false });
	const files = [];
	for (const entry of entries) {
		const bytes = logicalBytes(entry.path);
		writeFileSync(join(output, entry.stagedName), bytes);
		files.push({ source: entry.source, stagedName: entry.stagedName, bytes: bytes.length, sha256: sha256(bytes) });
	}
	writeFileSync(join(output, "validation.txt"), checkerOutput.endsWith("\n") ? checkerOutput : `${checkerOutput}\n`);
	files.push({
		source: "generated/golden-dataset.check.mjs output",
		stagedName: "validation.txt",
		bytes: statSync(join(output, "validation.txt")).size,
		sha256: sha256(readFileSync(join(output, "validation.txt"))),
	});
	const datasetFile = files.find((file) => file.source === "repo/experiments/golden-dataset.json");
	if (!datasetFile) throw new Error("staged inputs do not contain the final dataset");
	const provenance = {
		schemaVersion: 1,
		kind: "golden-dataset-v2-final-freeze",
		codeCommit,
		dataset: {
			version: dataset.version,
			active: dataset.issues.length,
			blocking: dataset.issues.filter((issue) => issue.tier === "blocking").length,
			rejected: dataset.rejected.length,
			sha256: datasetFile.sha256,
		},
		files,
	};
	writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
	return provenance;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const repo = resolve(argOf(args, "--repo", DEFAULT_REPO));
	const stateRoot = resolve(argOf(args, "--state-root", `${process.env.HOME}/scratch/2026-08-02-golden-v2`));
	const output = resolve(argOf(args, "--output", ""));
	if (!argOf(args, "--output", "")) throw new Error("--output is required and must name a new directory");
	const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" });
	if (status.trim()) throw new Error("worktree must be clean before the final freeze stage is built");
	const codeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
	const dataset = JSON.parse(readFileSync(join(repo, "experiments/golden-dataset.json"), "utf8"));
	assertFinalDataset(dataset);
	assertConsensusStateMatches(dataset, stateRoot);
	const checkerOutput = execFileSync("node", ["--test", "--test-reporter=tap", "experiments/golden-dataset.check.mjs"], { cwd: repo, encoding: "utf8" });
	if (!/^# pass 8$/m.test(checkerOutput) || !/^# fail 0$/m.test(checkerOutput)) throw new Error("dataset checker did not report 8 passing checks");
	const provenance = stageFreezeInputs({
		entries: buildFreezeInputPlan({ repo, stateRoot }),
		output,
		dataset,
		codeCommit,
		checkerOutput,
	});
	console.log(`staged ${provenance.files.length} hashed inputs for dataset ${dataset.version} at ${output}`);
}
