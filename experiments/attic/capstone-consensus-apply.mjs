#!/usr/bin/env node
/**
 * Apply the adversarial-verifier verdicts to the consensus-analyst batches.
 * Pure routing over the workflow journal: a credit survives only when the
 * verifier upheld it; every refutation is preserved for explicit analyst
 * resolution, never silently dropped. Zero provider calls.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const journalPath = argOf(args, "--journal", "");
const outDir = argOf(args, "--output", "");
if (!journalPath || !outDir) throw new Error("--journal and --output are required");

const results = readFileSync(journalPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line))
	.filter((entry) => entry.type === "result")
	.map((entry) => entry.value ?? entry.result ?? entry.data);
if (results.some((value) => value == null)) throw new Error("journal carries a result entry without a value");

const matches = new Map();
const verifies = new Map();
for (const value of results) {
	if (value.findings) {
		if (matches.has(value.batch)) throw new Error(`duplicate match batch ${value.batch}`);
		matches.set(value.batch, value);
	} else if (value.verdicts) {
		if (verifies.has(value.batch)) throw new Error(`duplicate verify batch ${value.batch}`);
		verifies.set(value.batch, value);
	} else throw new Error("journal result is neither a match nor a verify batch");
}
if (matches.size !== verifies.size) throw new Error(`unpaired batches: ${matches.size} match vs ${verifies.size} verify`);

const consensus = [];
const refuted = [];
const coverage = [];
const summary = {};
for (const [batch, match] of [...matches.entries()].sort()) {
	const verify = verifies.get(batch);
	if (!verify) throw new Error(`no verify result for ${batch}`);
	const input = batch.includes("fresh") ? "fresh" : "old";
	summary[input] ??= { findings: 0, defects: 0, bothSupported: 0, credited: 0, catalogIds: new Set(), disagreements: 0, novelCandidates: 0, refuted: 0 };
	const s = summary[input];
	const verdictFor = (sourceKey, description) => verify.verdicts.find(
		(v) => v.sourceKey === sourceKey && v.defectDescription === description,
	);
	for (const v of verify.verdicts.filter((entry) => entry.defectDescription === "COVERAGE")) {
		coverage.push({ batch, ...v });
	}
	for (const finding of match.findings) {
		s.findings += 1;
		const out = { batch, input, sourceKey: finding.sourceKey, defects: [], notes: finding.notes };
		for (const defect of finding.defects) {
			s.defects += 1;
			if (defect.bothSupported) s.bothSupported += 1;
			if (defect.disagreement) s.disagreements += 1;
			const scoringCritical = defect.bothSupported || (defect.catalogIssueIds ?? []).length > 0;
			const verdict = scoringCritical ? verdictFor(finding.sourceKey, defect.description) : null;
			const upheld = verdict ? verdict.upheld : null;
			if (scoringCritical && !verdict) {
				refuted.push({ batch, sourceKey: finding.sourceKey, description: defect.description, reason: "NO VERIFIER VERDICT — treat as unverified", verdict: "missing" });
			}
			if (verdict && !verdict.upheld) {
				s.refuted += 1;
				refuted.push({ batch, sourceKey: finding.sourceKey, description: defect.description, reason: verdict.reason, verdict: "refuted", defect });
			}
			const credited = defect.bothSupported && upheld === true;
			if (credited) {
				s.credited += 1;
				for (const id of defect.catalogIssueIds ?? []) s.catalogIds.add(id);
				if (defect.novelCandidate) s.novelCandidates += 1;
			}
			out.defects.push({ ...defect, verifierUpheld: upheld, credited });
		}
		consensus.push(out);
	}
}
for (const s of Object.values(summary)) s.catalogIds = [...s.catalogIds].sort();

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "consensus-findings.json"), `${JSON.stringify({ status: "analyst-review-pending", findings: consensus }, null, 1)}\n`);
writeFileSync(join(outDir, "refuted.json"), `${JSON.stringify(refuted, null, 1)}\n`);
writeFileSync(join(outDir, "coverage-checks.json"), `${JSON.stringify(coverage, null, 1)}\n`);
writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
console.log(`refutations + unverified: ${refuted.length}; coverage checks: ${coverage.length} (${coverage.filter((c) => !c.upheld).length} failed)`);
