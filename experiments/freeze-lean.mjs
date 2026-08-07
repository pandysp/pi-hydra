#!/usr/bin/env node
/**
 * Lean freeze: stage a run's build inputs as ONE hashed tar bundle plus a
 * per-file provenance manifest, instead of v2-style loose staged copies.
 * First used (as inline shell) for the golden v3 fold; committed so the
 * procedure is reproducible and reviewable for the next fold.
 *
 * Usage:
 *   node experiments/freeze-lean.mjs --kind <kind> --output <new dir> \
 *     --root <dir whose relative paths go into the tar> \
 *     --list <file with one root-relative path per line> \
 *     [--validation <file copied in as validation.txt>] [--note <text>]
 *
 * The output directory gains inputs.tar.gz, provenance.json (per-file
 * sha256 of every bundled input, bound to the current HEAD commit), and the
 * standard SHA256SUMS / SHA256SUMS.gz pair so the provenance invariants
 * gate covers it.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argOf } from "./lib.mjs";
import { buildManifests, formatManifest } from "./hydra-lab.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const args = process.argv.slice(2);
const kind = argOf(args, "--kind", "");
const output = argOf(args, "--output", "");
const root = resolve(argOf(args, "--root", ""));
const listPath = argOf(args, "--list", "");
const validationPath = argOf(args, "--validation", "");
const note = argOf(args, "--note", "");
if (!kind || !output || !listPath || !argOf(args, "--root", "")) {
	throw new Error("--kind, --output, --root and --list are required");
}
if (existsSync(output)) throw new Error(`freeze output already exists: ${output}`);

const relPaths = readFileSync(listPath, "utf8").trim().split("\n").filter(Boolean).sort();
const missing = relPaths.filter((rel) => !existsSync(join(root, rel)));
if (missing.length > 0) throw new Error(`inputs missing under ${root}:\n${missing.join("\n")}`);

mkdirSync(output, { recursive: false });
execFileSync("tar", ["czf", join(output, "inputs.tar.gz"), "-C", root, ...relPaths]);
if (validationPath) copyFileSync(validationPath, join(output, "validation.txt"));

const provenance = {
	schemaVersion: 1,
	kind,
	codeCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
	note: note || "Lean freeze: hash-addressed inputs inside inputs.tar.gz; per-file hashes below bind the bundle contents.",
	bundle: {
		file: "inputs.tar.gz",
		sha256: sha256(readFileSync(join(output, "inputs.tar.gz"))),
		root: root.replace(process.env.HOME, "~"),
		files: relPaths.map((rel) => {
			const bytes = readFileSync(join(root, rel));
			return { source: rel, bytes: bytes.length, sha256: sha256(bytes) };
		}),
	},
	...(validationPath ? { validation: { file: "validation.txt", sha256: sha256(readFileSync(join(output, "validation.txt"))) } } : {}),
};
writeFileSync(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

const { logical, stored } = buildManifests(output);
writeFileSync(join(output, "SHA256SUMS"), formatManifest(logical));
writeFileSync(join(output, "SHA256SUMS.gz"), formatManifest(stored));
console.log(`froze ${relPaths.length} inputs into ${output} (${provenance.bundle.sha256.slice(0, 16)}…)`);
