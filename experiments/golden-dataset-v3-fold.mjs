#!/usr/bin/env node
/**
 * Fold the iteration-2 settled outcomes into `golden-dataset.json` (v3).
 *
 * Input is the fail-closed extraction `settled-outcomes.json` (generator in
 * the same scratch directory): every item there carries its converging votes,
 * byte-exact provenance to the wave checkpoint files, and — for anchors — a
 * byte-verification against the frozen frame sources. Two unanimously voted
 * anchors were refuted by that verification (BF-d44, SCHED-r-d35) and are
 * NOT in the fold; they sit in the blinded human queue instead. Votes do not
 * override bytes.
 *
 * Phase order matters: statement replacements first (they change the claim a
 * record makes), then the rule adoption, then anchors (which pin the NEW
 * claims — BF-g22R anchors the RG22 replacement statement). The version is
 * recomputed with the same content formula the validators enforce, so every
 * consumer sees the fold as a new catalog version and nothing pooled across
 * versions can go unnoticed.
 */

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import { realCatalogVersion, validateRealCatalog } from "./dual-catalog.mjs";

const args = process.argv.slice(2);
const SETTLED_PATH = argOf(
	args,
	"--settled",
	`${process.env.HOME}/scratch/2026-08-04-iter2-reconciliation/settled-outcomes.json`,
);
const DATASET_PATH = argOf(args, "--dataset", "experiments/golden-dataset.json");
const REPAIR_STATE_DIR = "~/scratch/2026-08-04-iter2-wave/consensus-repairs";

const settledBytes = readFileSync(SETTLED_PATH);
const settled = JSON.parse(settledBytes.toString("utf8"));
const datasetRaw = readFileSync(DATASET_PATH, "utf8");
const dataset = JSON.parse(datasetRaw);

if (dataset.builtFrom?.iteration2Fold) throw new Error("dataset already carries an iteration-2 fold");
if (settled.counts?.items !== settled.items?.length) throw new Error("settled-outcomes counts do not match its items");

const byId = new Map(dataset.issues.map((issue) => [issue.id, issue]));
const preFoldTier = new Map(dataset.issues.map((issue) => [issue.id, issue.tier]));
const previousVersion = dataset.version;

const targetOf = (item) => {
	const target = byId.get(item.targetRecord);
	if (!target) throw new Error(`${item.id}: target record ${item.targetRecord} absent from dataset`);
	return target;
};

const applied = { statements: [], termination: [], rule: [], anchors: [] };
const PHASES = [
	["statement-replacement", "option-a-termination"],
	["rule-adoption"],
	["anchor-repair", "backfill"],
];
const known = new Set(PHASES.flat());
for (const item of settled.items) {
	if (!known.has(item.kind)) throw new Error(`${item.id}: unknown settled outcome kind ${item.kind}`);
}

for (const phase of PHASES) {
	for (const item of settled.items.filter((candidate) => phase.includes(candidate.kind))) {
		if (item.kind === "rule-adoption") {
			dataset.anchorRule = {
				id: item.id,
				adopted: "2026-08-04",
				text: item.ruleTextVerbatim,
				provenance: item.provenance,
			};
			applied.rule.push(item.id);
			continue;
		}
		const target = targetOf(item);
		if (item.kind === "statement-replacement" || item.kind === "option-a-termination") {
			target.precisionRepair = {
				replaces: item.id,
				previousStatement: target.statement,
				stateDir: REPAIR_STATE_DIR,
			};
			target.statement = item.statement;
			target.tier = item.tier;
			target.votes = item.votes.positions;
			if (item.dissent) {
				target.consensus = "unresolved";
				target.dissent =
					`${item.dissent.by} dissent carried verbatim under Option A termination ` +
					`(round ${item.votes.round}, ${REPAIR_STATE_DIR}): ${item.dissent.verbatim}`;
				applied.termination.push(item.id);
			} else {
				target.consensus = "unanimous";
				applied.statements.push(item.id);
			}
			continue;
		}
		// anchor-repair / backfill: adopt the byte-verified anchors; the vote
		// certified "changes no recorded outcome", so any tier drift since the
		// extraction ran is a hard stop.
		if (!item.anchors) throw new Error(`${item.id}: anchor outcome carries no parsed anchors`);
		if (!item.tier?.unchanged || item.tier.current !== preFoldTier.get(item.targetRecord)) {
			throw new Error(`${item.id}: tier drift on ${item.targetRecord} since extraction`);
		}
		target.anchors = item.anchors;
		applied.anchors.push(item.id);
	}
}

const appliedTotal = Object.values(applied).reduce((n, list) => n + list.length, 0);
if (appliedTotal !== settled.items.length) {
	throw new Error(`applied ${appliedTotal} of ${settled.items.length} settled items`);
}

dataset.builtFrom.iteration2Fold = {
	settledOutcomes: {
		path: SETTLED_PATH.replace(process.env.HOME, "~"),
		sha256: createHash("sha256").update(settledBytes).digest("hex"),
		items: settled.items.length,
		excluded: settled.excluded.length,
	},
	applied,
	previousVersion,
	blindedQueue: [
		"AC13B", "SCHED-c-15", "DISP-o-xd-g20", "DISP-o-xd-g26",
		"SCHED-o-g07", "SCHED-o-g14", "SCHED-r-d18",
		"BF-d39", "BF-g21R", "BF-d44", "SCHED-r-d35",
	],
	notes:
		"Every folded anchor byte-verified against artifacts/2026-08-02-golden-dataset-v2/" +
		"frame-sources.json.gz; BF-d44 and SCHED-r-d35 were unanimously voted but refuted " +
		"by bytes and route to the blinded queue. EXP-o-xe-g21 keeps its v2 anchor: its " +
		"corrected anchor (BF-g21R) carries an opus dissent and awaits the blinded ruling.",
};

dataset.version = realCatalogVersion(dataset.issues);
validateRealCatalog(dataset);

const trailingNewline = datasetRaw.endsWith("\n") ? "\n" : "";
const temporary = `${DATASET_PATH}.${process.pid}.tmp`;
writeFileSync(temporary, JSON.stringify(dataset, null, 1) + trailingNewline);
renameSync(temporary, DATASET_PATH);

const blocking = dataset.issues.filter((issue) => issue.tier === "blocking").length;
console.log(
	`folded ${appliedTotal} settled outcomes: ${previousVersion} -> ${dataset.version} ` +
	`(${dataset.issues.length} active, ${blocking} blocking; ` +
	`statements ${applied.statements.length + applied.termination.length}, anchors ${applied.anchors.length}, rule ${applied.rule.length})`,
);
