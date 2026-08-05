#!/usr/bin/env node
/**
 * Fold the analyst's explicit resolutions into the verifier-applied consensus.
 * Every resolution targets one (sourceKey, description) pair and is recorded
 * in-band; anything untargeted passes through unchanged. Fails closed on a
 * resolution that matches nothing or a scoring-critical defect left without
 * either a verifier verdict or a resolution.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argOf } from "../lib.mjs";

const args = process.argv.slice(2);
const dir = argOf(args, "--applied", "");
const resolutionsPath = argOf(args, "--resolutions", "");
if (!dir || !resolutionsPath) throw new Error("--applied and --resolutions are required");

const applied = JSON.parse(readFileSync(join(dir, "consensus-findings.json"), "utf8"));
const { resolutions, resolvedBy } = JSON.parse(readFileSync(resolutionsPath, "utf8"));
const used = new Set();

for (const finding of applied.findings) {
	const extra = [];
	for (const defect of finding.defects) {
		const resolution = resolutions.find(
			(r) => r.sourceKey === finding.sourceKey && r.description === defect.description,
		);
		if (!resolution) continue;
		used.add(resolution);
		defect.analystResolution = { resolution: resolution.resolution, reason: resolution.reason };
		switch (resolution.resolution) {
			case "uphold-refutation":
				defect.credited = false;
				break;
			case "analyst-direct-verdict-uphold":
				defect.credited = defect.bothSupported;
				break;
			case "restore-credit-drop-novel":
				defect.credited = defect.bothSupported;
				defect.novelCandidate = false;
				break;
			case "restore-narrowed":
				defect.credited = defect.bothSupported;
				defect.description = resolution.narrowedDescription;
				if (resolution.carveOut) {
					extra.push({
						description: resolution.carveOut.description,
						bothSupported: false,
						solClaimRefs: resolution.carveOut.solOnly ? defect.solClaimRefs : [],
						opusClaimRefs: [],
						catalogIssueIds: [],
						disagreement: resolution.carveOut.disagreement,
						novelCandidate: false,
						verifierUpheld: null,
						credited: false,
						analystResolution: { resolution: "carve-out", reason: resolution.reason },
					});
				}
				break;
			default:
				throw new Error(`unknown resolution kind ${resolution.resolution}`);
		}
	}
	finding.defects.push(...extra);
}
const unused = resolutions.filter((r) => !used.has(r));
if (unused.length) throw new Error(`resolutions matching nothing: ${unused.map((r) => r.sourceKey).join(", ")}`);
const dangling = applied.findings.flatMap((f) => f.defects.filter(
	(d) => (d.bothSupported || (d.catalogIssueIds ?? []).length > 0) && d.verifierUpheld == null && !d.analystResolution,
).map((d) => `${f.sourceKey} :: ${d.description.slice(0, 60)}`));
if (dangling.length) throw new Error(`scoring-critical defects with neither verdict nor resolution:\n${dangling.join("\n")}`);

const summary = {};
for (const finding of applied.findings) {
	const input = finding.input;
	summary[input] ??= { findings: 0, credited: 0, catalogIds: new Set(), disagreements: 0, novelCandidates: 0 };
	const s = summary[input];
	s.findings += 1;
	for (const defect of finding.defects) {
		if (defect.disagreement) s.disagreements += 1;
		if (!defect.credited) continue;
		s.credited += 1;
		for (const id of defect.catalogIssueIds ?? []) s.catalogIds.add(id);
		if (defect.novelCandidate) s.novelCandidates += 1;
	}
}
for (const s of Object.values(summary)) s.catalogIds = [...s.catalogIds].sort();

applied.status = "analyst-resolved";
applied.resolvedBy = resolvedBy;
writeFileSync(join(dir, "consensus-final.json"), `${JSON.stringify(applied, null, 1)}\n`);
writeFileSync(join(dir, "summary-final.json"), `${JSON.stringify(summary, null, 1)}\n`);
console.log(JSON.stringify(summary, null, 1));
