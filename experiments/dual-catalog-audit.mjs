#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeDualCatalogOutcome } from "./dual-catalog-reconcile.mjs";
import { argOf } from "./lib.mjs";

export const EXPANDED_2Q_AUDIT_SEED_RULE = "expanded-2q-audit-v2-stratified";

const AGREEMENT_STATUSES = new Set([
	"matched",
	"settled-unmatched",
	"unresolved",
]);
const KNOWN_STATUSES = new Set([
	...AGREEMENT_STATUSES,
	"awaiting-human",
	"invalid-output",
	"unjudgeable",
]);
const PUBLIC_CASE_FIELDS = new Set([
	"caseId",
	"task",
	"finding",
	"evidenceRef",
	"evidence",
	"judges",
	"proposedRecord",
]);
const FORBIDDEN_PUBLIC_KEYS = new Set([
	"sourcekey",
	"arm",
	"config",
	"model",
	"judgemodel",
	"provider",
	"judgeprovider",
	"privatemapping",
	"judgelabels",
	"blindingkey",
]);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, item]) => [key, canonical(item)]),
		);
	}
	return value;
}

const stable = (value) => JSON.stringify(canonical(value));

function nonEmptyString(value, label) {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${label} must be a non-empty string`);
}

function assertCap(value, label) {
	if (!Number.isInteger(value) || value < 0)
		throw new Error(`${label} must be a non-negative integer`);
}

export function rankDualCatalogAuditCase(packetId, caseId) {
	nonEmptyString(packetId, "packetId");
	nonEmptyString(caseId, "caseId");
	return createHash("sha256")
		.update(EXPANDED_2Q_AUDIT_SEED_RULE)
		.update(packetId)
		.update(caseId)
		.digest("hex");
}

function normalizedOutcome(value, label) {
	try {
		return normalizeDualCatalogOutcome({ outcome: value });
	} catch (error) {
		throw new Error(
			`${label}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function agreementOutcome(decision) {
	if (
		!decision?.judges?.sol?.outcome ||
		!decision?.judges?.opus?.outcome ||
		!decision?.outcome
	) {
		throw new Error(
			`${decision?.caseId ?? "decision"}: agreement is missing judge or settled outcomes`,
		);
	}
	const sol = normalizedOutcome(
		decision.judges.sol.outcome,
		`${decision.caseId} Sol outcome`,
	);
	const opus = normalizedOutcome(
		decision.judges.opus.outcome,
		`${decision.caseId} Opus outcome`,
	);
	const settled = normalizedOutcome(
		decision.outcome,
		`${decision.caseId} settled outcome`,
	);
	if (stable(sol) !== stable(opus) || stable(sol) !== stable(settled)) {
		throw new Error(
			`${decision.caseId}: decision is not an exact judge agreement`,
		);
	}
	const matched =
		settled.realMatches.length > 0 || settled.falseMatches.length > 0;
	if (decision.status === "matched" && !matched)
		throw new Error(
			`${decision.caseId}: matched agreement has no catalog match`,
		);
	if (
		decision.status === "settled-unmatched" &&
		(matched || !["real", "false"].includes(settled.unmatched?.truth))
	) {
		throw new Error(
			`${decision.caseId}: settled-unmatched agreement is not a real or false catalog miss`,
		);
	}
	if (
		decision.status === "unresolved" &&
		(matched || settled.unmatched?.truth !== "unclear")
	) {
		throw new Error(`${decision.caseId}: unresolved agreement is not unclear`);
	}
	return settled;
}

function assertSafePublicValue(value, path = "reviewCase") {
	if (typeof value === "string") {
		if (/\b[0-9a-f]{32,}\b/i.test(value))
			throw new Error(`${path}: raw hash leaked into public audit material`);
		if (
			/\b(?:MAIN|ENUM|F2)(?:-SO2)?\b/.test(value) ||
			/\b(?:sol|opus)-(?:high|xhigh)\b/i.test(value)
		) {
			throw new Error(
				`${path}: arm or config leaked into public audit material`,
			);
		}
		if (/\b(?:gpt-\d|claude-[a-z0-9]|openai-codex)\b/i.test(value)) {
			throw new Error(
				`${path}: model identity leaked into public audit material`,
			);
		}
		if (/blinding[-_ ]?key/i.test(value))
			throw new Error(
				`${path}: blinding key leaked into public audit material`,
			);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			assertSafePublicValue(item, `${path}[${index}]`);
		});
		return;
	}
	if (!value || typeof value !== "object") return;
	for (const [key, item] of Object.entries(value)) {
		const normalized = key.toLowerCase().replace(/[-_]/g, "");
		if (
			FORBIDDEN_PUBLIC_KEYS.has(normalized) ||
			normalized.includes("hash") ||
			normalized.includes("sha256") ||
			normalized.includes("blinding")
		) {
			throw new Error(
				`${path}.${key}: private field is forbidden in public audit material`,
			);
		}
		assertSafePublicValue(item, `${path}.${key}`);
	}
}

function assertPublicJudge(judge, caseId, index) {
	if (!judge || typeof judge !== "object" || Array.isArray(judge))
		throw new Error(`${caseId}: public judge ${index} must be an object`);
	const keys = Object.keys(judge).sort();
	if (
		stable(keys) !== stable(["label", "outcome", "quote", "reasoning"].sort())
	) {
		throw new Error(
			`${caseId}: public judge fields are not the blinded contract`,
		);
	}
	if (!["A", "B"].includes(judge.label))
		throw new Error(`${caseId}: public judge label must be A or B`);
	nonEmptyString(judge.quote, `${caseId} public judge quote`);
	nonEmptyString(judge.reasoning, `${caseId} public judge reasoning`);
	return normalizedOutcome(judge.outcome, `${caseId} public judge outcome`);
}

function assertNoPrivateDecisionLeak(reviewCase, decision) {
	const publicText = JSON.stringify(reviewCase);
	const identity = decision?.identity ?? {};
	const secrets = [
		decision?.sourceKey,
		identity.sourceKey,
		identity.arm,
		identity.config,
		...Object.values(decision?.evidenceHashes ?? {}),
		...[identity.runId, identity.pointKey, identity.pointId].filter(
			(value) => typeof value === "string" && value.length >= 4,
		),
	];
	for (const secret of secrets) {
		if (typeof secret === "string" && secret && publicText.includes(secret)) {
			throw new Error(
				`${reviewCase.caseId}: private decision identity leaked into public audit material`,
			);
		}
	}
}

function publicAuditCase(reviewCase, decisionOutcome, status, decision, catalog) {
	if (
		!reviewCase ||
		typeof reviewCase !== "object" ||
		Array.isArray(reviewCase)
	)
		throw new Error("public review case must be an object");
	for (const key of Object.keys(reviewCase)) {
		if (!PUBLIC_CASE_FIELDS.has(key))
			throw new Error(
				`${reviewCase.caseId ?? "reviewCase"}: forbidden public review field ${key}`,
			);
	}
	nonEmptyString(reviewCase.caseId, "review caseId");
	if (!/^case-[0-9a-f]{16}$/.test(reviewCase.caseId))
		throw new Error(`${reviewCase.caseId}: malformed opaque case id`);
	nonEmptyString(reviewCase.task, `${reviewCase.caseId} task`);
	if (!catalog) throw new Error(`${reviewCase.caseId}: no public catalog for task ${reviewCase.task}`);
	const realIds = new Set(catalog.real.map((entry) => entry.id));
	const falseIds = new Set(catalog.false.map((entry) => entry.id));
	if (decisionOutcome.realMatches.some((id) => !realIds.has(id))) {
		throw new Error(`${reviewCase.caseId}: matched real id is absent from the public catalog`);
	}
	if (decisionOutcome.falseMatches.some((id) => !falseIds.has(id))) {
		throw new Error(`${reviewCase.caseId}: matched false id is absent from the public catalog`);
	}
	nonEmptyString(reviewCase.finding, `${reviewCase.caseId} finding`);
	nonEmptyString(reviewCase.evidenceRef, `${reviewCase.caseId} evidenceRef`);
	if (!/^evidence-[0-9a-f]{16}$/.test(reviewCase.evidenceRef))
		throw new Error(
			`${reviewCase.caseId}: malformed opaque evidence reference`,
		);
	if (!Array.isArray(reviewCase.judges) || reviewCase.judges.length !== 2)
		throw new Error(
			`${reviewCase.caseId}: an agreement needs two blinded judges`,
		);
	const publicOutcomes = reviewCase.judges.map((judge, index) =>
		assertPublicJudge(judge, reviewCase.caseId, index),
	);
	if (new Set(reviewCase.judges.map((judge) => judge.label)).size !== 2)
		throw new Error(
			`${reviewCase.caseId}: blinded judge labels must be unique`,
		);
	if (
		publicOutcomes.some(
			(outcome) => stable(outcome) !== stable(decisionOutcome),
		)
	) {
		throw new Error(
			`${reviewCase.caseId}: public review case does not carry the agreed outcome`,
		);
	}
	if (status === "settled-unmatched") {
		if (
			!reviewCase.proposedRecord ||
			typeof reviewCase.proposedRecord !== "object"
		) {
			throw new Error(
				`${reviewCase.caseId}: catalog miss lacks a proposed record`,
			);
		}
		const keys = Object.keys(reviewCase.proposedRecord).sort();
		if (stable(keys) !== stable(["proposition", "severity", "truth"].sort())) {
			throw new Error(
				`${reviewCase.caseId}: proposed record fields are not public-safe`,
			);
		}
		if (
			reviewCase.proposedRecord.proposition !== reviewCase.finding ||
			reviewCase.proposedRecord.truth !== decisionOutcome.unmatched.truth ||
			reviewCase.proposedRecord.severity !== decisionOutcome.unmatched.severity
		) {
			throw new Error(
				`${reviewCase.caseId}: proposed record differs from the agreed catalog miss`,
			);
		}
	} else if (reviewCase.proposedRecord !== undefined) {
		throw new Error(
			`${reviewCase.caseId}: matched agreement must not propose catalog growth`,
		);
	}
	assertNoPrivateDecisionLeak(reviewCase, decision);
	assertSafePublicValue(reviewCase);
	return {
		caseId: reviewCase.caseId,
		task: reviewCase.task,
		finding: reviewCase.finding,
		evidenceRef: reviewCase.evidenceRef,
		...(reviewCase.evidence === undefined
			? {}
			: { evidence: reviewCase.evidence }),
		judges: reviewCase.judges,
		...(reviewCase.proposedRecord === undefined
			? {}
			: { proposedRecord: reviewCase.proposedRecord }),
	};
}

function sampleStratum(row, kind) {
	const outcome = normalizedOutcome(row.judges[0].outcome, `${row.caseId} sample outcome`);
	if (kind === "matched") {
		return `${row.task}\0real:${outcome.realMatches.join(",")}\0false:${outcome.falseMatches.join(",")}`;
	}
	return `${row.task}\0${outcome.unmatched.truth}\0${outcome.unmatched.severity}`;
}

function stratifiedSample(rows, packetId, cap, kind) {
	const buckets = new Map();
	for (const row of rows) {
		const stratum = sampleStratum(row, kind);
		if (!buckets.has(stratum)) buckets.set(stratum, []);
		buckets.get(stratum).push(row);
	}
	const orderedBuckets = [...buckets.entries()]
		.map(([stratum, items]) => ({
			stratum,
			rank: rankDualCatalogAuditCase(packetId, `${kind}-stratum-${stratum}`),
			items: items.sort((a, b) =>
				rankDualCatalogAuditCase(packetId, a.caseId).localeCompare(rankDualCatalogAuditCase(packetId, b.caseId)) ||
				a.caseId.localeCompare(b.caseId)),
		}))
		.sort((a, b) => a.rank.localeCompare(b.rank) || a.stratum.localeCompare(b.stratum));
	const sampled = [];
	for (let round = 0; sampled.length < cap; round++) {
		let added = false;
		for (const bucket of orderedBuckets) {
			if (bucket.items[round] && sampled.length < cap) {
				sampled.push(bucket.items[round]);
				added = true;
			}
		}
		if (!added) break;
	}
	return sampled;
}

function validatePublicCatalogs(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("publicCatalogs must be an object keyed by task");
	}
	const result = {};
	for (const [task, catalog] of Object.entries(value)) {
		nonEmptyString(task, "public catalog task");
		if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.real) || !Array.isArray(catalog.false)) {
			throw new Error(`${task}: public catalog requires real[] and false[]`);
		}
		const ids = new Set();
		const lane = (entries, label) => entries.map((entry) => {
			if (!entry || typeof entry !== "object" || Array.isArray(entry) || stable(Object.keys(entry).sort()) !== stable(["id", "statement"])) {
				throw new Error(`${task}: ${label} public catalog entry fields must be id and statement`);
			}
			nonEmptyString(entry.id, `${task} ${label} catalog id`);
			nonEmptyString(entry.statement, `${task} ${label} catalog statement`);
			if (ids.has(entry.id)) throw new Error(`${task}: duplicate public catalog id ${entry.id}`);
			ids.add(entry.id);
			return { id: entry.id, statement: entry.statement };
		});
		result[task] = { real: lane(catalog.real, "real"), false: lane(catalog.false, "false") };
	}
	assertSafePublicValue(result, "publicCatalogs");
	return result;
}

export function buildDualCatalogAuditPacket(
	reconciliation,
	{ matchedCap, catalogMissCap } = {},
) {
	assertCap(matchedCap, "matchedCap");
	assertCap(catalogMissCap, "catalogMissCap");
	if (!reconciliation || typeof reconciliation !== "object")
		throw new Error("reconciliation must be an object");
	nonEmptyString(reconciliation.packetId, "packetId");
	if (!Array.isArray(reconciliation.agreementCaseIds))
		throw new Error("agreementCaseIds must be an array");
	if (
		!reconciliation.decisions ||
		typeof reconciliation.decisions !== "object" ||
		Array.isArray(reconciliation.decisions)
	) {
		throw new Error("decisions must be an object");
	}
	if (
		!reconciliation.reviewCases ||
		typeof reconciliation.reviewCases !== "object" ||
		Array.isArray(reconciliation.reviewCases)
	) {
		throw new Error("reviewCases must be an object");
	}
	const publicCatalogs = validatePublicCatalogs(reconciliation.publicCatalogs);

	const decisionsByCase = new Map();
	for (const decision of Object.values(reconciliation.decisions)) {
		nonEmptyString(decision?.caseId, "decision caseId");
		if (!KNOWN_STATUSES.has(decision.status))
			throw new Error(
				`${decision.caseId}: unknown decision status ${decision.status}`,
			);
		if (decisionsByCase.has(decision.caseId))
			throw new Error(`${decision.caseId}: duplicate decision caseId`);
		decisionsByCase.set(decision.caseId, decision);
	}
	const agreementIds = new Set(reconciliation.agreementCaseIds);
	if (agreementIds.size !== reconciliation.agreementCaseIds.length)
		throw new Error("agreementCaseIds contains duplicates");
	const expectedAgreementIds = new Set(
		[...decisionsByCase.values()]
			.filter((decision) => AGREEMENT_STATUSES.has(decision.status))
			.map((decision) => decision.caseId),
	);
	if (
		stable([...agreementIds].sort()) !==
		stable([...expectedAgreementIds].sort())
	) {
		throw new Error(
			"agreementCaseIds does not exactly cover agreement decisions",
		);
	}

	const matched = [];
	const catalogMisses = [];
	let unresolved = 0;
	for (const caseId of reconciliation.agreementCaseIds) {
		const decision = decisionsByCase.get(caseId);
		if (!decision || !AGREEMENT_STATUSES.has(decision.status))
			throw new Error(`${caseId}: referenced decision is not an agreement`);
		const reviewCase = reconciliation.reviewCases[caseId];
		if (!reviewCase)
			throw new Error(`${caseId}: referenced public review case is missing`);
		if (reviewCase.caseId !== caseId)
			throw new Error(`${caseId}: public review case id differs`);
		const outcome = agreementOutcome(decision);
		const task = reviewCase.task;
		const catalog = publicCatalogs[task];
		if (decision.status === "matched")
			matched.push(
				publicAuditCase(reviewCase, outcome, decision.status, decision, catalog),
			);
		else if (decision.status === "settled-unmatched")
			catalogMisses.push(
				publicAuditCase(reviewCase, outcome, decision.status, decision, catalog),
			);
		else {
			publicAuditCase(reviewCase, outcome, decision.status, decision, catalog);
			unresolved += 1;
		}
	}
	const matchedSample = stratifiedSample(matched, reconciliation.packetId, matchedCap, "matched");
	const catalogMissSample = stratifiedSample(catalogMisses, reconciliation.packetId, catalogMissCap, "catalog-miss");
	const sampledTasks = [...new Set([...matchedSample, ...catalogMissSample].map((row) => row.task))].sort();

	const packet = {
		schemaVersion: 1,
		seedRule: EXPANDED_2Q_AUDIT_SEED_RULE,
		packetId: reconciliation.packetId,
		publicCatalogs: Object.fromEntries(sampledTasks.map((task) => [task, publicCatalogs[task]])),
		counts: {
			agreementCases: reconciliation.agreementCaseIds.length,
			matchedAgreements: matched.length,
			matchedCap,
			matchedSampled: Math.min(matched.length, matchedCap),
			catalogMissCandidates: catalogMisses.length,
			catalogMissCap,
			catalogMissSampled: Math.min(catalogMisses.length, catalogMissCap),
			unresolvedAgreements: unresolved,
		},
		samples: {
			matchedAgreements: matchedSample,
			catalogMissCandidates: catalogMissSample,
		},
	};
	assertSafePublicValue(packet);
	return packet;
}

function main() {
	const args = process.argv.slice(2);
	const reconciliationPath = argOf(args, "--reconciliation", "");
	const outputPath = argOf(args, "--output", "");
	const matchedCapRaw = argOf(args, "--matched-cap", "");
	const catalogMissCapRaw = argOf(args, "--catalog-miss-cap", "");
	if (
		!reconciliationPath ||
		!outputPath ||
		matchedCapRaw === "" ||
		catalogMissCapRaw === ""
	) {
		throw new Error(
			"--reconciliation, --output, --matched-cap and --catalog-miss-cap are required",
		);
	}
	const packet = buildDualCatalogAuditPacket(
		JSON.parse(readFileSync(reconciliationPath, "utf8")),
		{
			matchedCap: Number(matchedCapRaw),
			catalogMissCap: Number(catalogMissCapRaw),
		},
	);
	writeFileSync(outputPath, `${JSON.stringify(packet, null, 2)}\n`);
	process.stdout.write(
		`audit packet: ${packet.counts.matchedSampled}/${packet.counts.matchedAgreements} matched agreements, ${packet.counts.catalogMissSampled}/${packet.counts.catalogMissCandidates} catalog misses\n`,
	);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
