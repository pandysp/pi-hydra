import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { argOf } from "./lib.mjs";
import {
	buildDualCatalogView,
	dualCatalogHashes,
	loadFalsePositiveCatalog,
	loadRealCatalog,
} from "./dual-catalog.mjs";

const COMPLETE = new Set(["complete", "complete-with-unjudgeable", "complete-with-exceptions"]);
const EXECUTION_METADATA = new Set([
	"judge",
	"judgeModel",
	"judgeProvider",
	"judgeReasoning",
	"judgeTransport",
	"transport",
	"provider",
	"model",
	"reasoning",
	"carrier",
	"carrierShape",
	"carrierShapeSha256",
	"shapeSource",
	"shapeMember",
	"shapeSha256",
	"transformHash",
	"judgeShape",
	"judgeRoute",
	"judgeReplayTransformHash",
	"concurrency",
]);
const IDENTITY_KEYS = [
	"sourceKey",
	"runId",
	"pointKey",
	"pointId",
	"task",
	"config",
	"arm",
	"findingIndex",
	"message",
	"pointKind",
	"requestIndex",
	"runIndex",
	"qualitySourceValidity",
];
const EVIDENCE_HASH_KEYS = ["evidenceHash", "promptHash", "payloadHash", "capturedPayloadHash"];

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, canonical(item)]));
	}
	return value;
}

const stable = (value) => JSON.stringify(canonical(value));
const sortedKeys = (value) => Object.keys(value ?? {}).sort();

function basisOf(metadata) {
	return Object.fromEntries(Object.entries(metadata ?? {}).filter(([key]) => !EXECUTION_METADATA.has(key)));
}

function publicCatalogsOf(realCatalog, falseCatalog, basis) {
	if (!basis.catalogHashes || typeof basis.catalogHashes !== "object" || Array.isArray(basis.catalogHashes)) {
		throw new Error("judge input metadata must bind catalogHashes by task");
	}
	const hashes = dualCatalogHashes(realCatalog, falseCatalog);
	if (hashes.realVersion !== basis.realCatalogVersion || hashes.falseVersion !== basis.falseCatalogVersion) {
		throw new Error("catalog versions differ from judge input metadata");
	}
	if (stable(hashes.perTask) !== stable(basis.catalogHashes)) {
		throw new Error("rendered catalog hashes differ from judge input metadata");
	}
	const result = {};
	for (const task of Object.keys(hashes.perTask).sort()) {
		const view = buildDualCatalogView(realCatalog, falseCatalog, task);
		const ids = new Set();
		const lane = (entries, label) => entries.map((entry) => {
			if (typeof entry?.id !== "string" || !entry.id || typeof entry?.statement !== "string" || !entry.statement.trim()) {
				throw new Error(`${task}: ${label} catalog entries require id and statement`);
			}
			if (ids.has(entry.id)) throw new Error(`${task}: duplicate public catalog id ${entry.id}`);
			ids.add(entry.id);
			return { id: entry.id, statement: entry.statement };
		});
		result[task] = { real: lane(view.real, "real"), false: lane(view.false, "false") };
	}
	return result;
}

function identityOf(judgment, sourceKey) {
	const identity = Object.fromEntries(IDENTITY_KEYS
		.filter((key) => judgment?.[key] !== undefined)
		.map((key) => [key, judgment[key]]));
	identity.sourceKey ??= sourceKey;
	return identity;
}

function batchFor(state, sourceKey) {
	return (state?.batches ?? []).find((batch) => Array.isArray(batch?.sourceKeys) && batch.sourceKeys.includes(sourceKey)) ?? null;
}

function evidenceHashesOf(judgment, batch = null) {
	return Object.fromEntries(EVIDENCE_HASH_KEYS
		.filter((key) => judgment?.[key] !== undefined || batch?.[key] !== undefined)
		.map((key) => [key, judgment?.[key] ?? batch[key]]));
}

function evidenceOf(judgment, batch = null) {
	if (judgment?.evidence !== undefined) return judgment.evidence;
	if (judgment?.visibleEvidence !== undefined) return judgment.visibleEvidence;
	if (batch?.evidence !== undefined) return batch.evidence;
	if (batch?.visibleEvidence !== undefined) return batch.visibleEvidence;
	const evidence = {};
	if (judgment?.visibleTranscript !== undefined || batch?.visibleTranscript !== undefined) {
		evidence.visibleTranscript = judgment?.visibleTranscript ?? batch.visibleTranscript;
	}
	if (judgment?.files !== undefined || batch?.files !== undefined) evidence.files = judgment?.files ?? batch.files;
	return Object.keys(evidence).length ? evidence : undefined;
}

function matchId(match) {
	if (typeof match === "string" && match) return match;
	if (!match || typeof match !== "object") return null;
	return match.issueId ?? match.falsePositiveId ?? match.catalogId ?? match.id ?? match.key ?? null;
}

function normalizeMatches(matches, label) {
	if (!Array.isArray(matches)) throw new Error(`${label} must be an array`);
	const ids = matches.map(matchId);
	if (ids.some((id) => typeof id !== "string" || !id)) throw new Error(`${label} contains an invalid catalog id`);
	if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate catalog ids`);
	return [...ids].sort();
}

function rawOutcomeOf(judgment) {
	for (const candidate of [judgment?.outcome, judgment?.judgment, judgment]) {
		if (candidate && Object.hasOwn(candidate, "realMatches") && Object.hasOwn(candidate, "falseMatches")) return candidate;
	}
	throw new Error(`${judgment?.sourceKey ?? "judgment"}: missing dual-catalog outcome`);
}

export function normalizeDualCatalogOutcome(judgment) {
	const raw = rawOutcomeOf(judgment);
	const realMatches = normalizeMatches(raw.realMatches, "realMatches");
	const falseMatches = normalizeMatches(raw.falseMatches, "falseMatches");
	if (realMatches.length && falseMatches.length) throw new Error("real and false match lanes cannot both be non-empty");
	const matched = realMatches.length > 0 || falseMatches.length > 0;
	let unmatched = raw.unmatched;
	if (matched && unmatched !== null) throw new Error("a matched outcome cannot also be unmatched");
	if (!matched) {
		if (!unmatched || typeof unmatched !== "object") throw new Error("an unmatched outcome needs a classification");
		if (!["real", "false", "unclear"].includes(unmatched.truth)) throw new Error(`unknown unmatched truth ${unmatched.truth}`);
		if (unmatched.truth === "unclear") {
			if (unmatched.severity !== null) throw new Error("unclear severity must be null");
		} else if (!["severe", "minor"].includes(unmatched.severity)) {
			throw new Error(`${unmatched.truth} severity must be severe or minor`);
		}
		unmatched = { truth: unmatched.truth, severity: unmatched.severity };
	}
	return { realMatches, falseMatches, unmatched: matched ? null : unmatched };
}

function outcomeSignature(outcome) {
	return stable({
		realMatches: [...outcome.realMatches].sort(),
		falseMatches: [...outcome.falseMatches].sort(),
		unmatched: outcome.unmatched,
	});
}

function validateState(state, judge) {
	if (!COMPLETE.has(state?.status)) throw new Error(`${judge} checkpoint is not complete`);
	if (state?.metadata?.judge !== judge) throw new Error(`expected ${judge} checkpoint, got ${state?.metadata?.judge ?? "none"}`);
	for (const [sourceKey, judgment] of Object.entries(state.judgments ?? {})) {
		if (judgment?.sourceKey !== undefined && judgment.sourceKey !== sourceKey) {
			throw new Error(`${judge} judgment key disagrees with sourceKey: ${sourceKey}`);
		}
	}
	const buckets = [state.judgments ?? {}, state.invalidOutputs ?? {}, state.unjudgeable ?? {}];
	const accounted = buckets.flatMap((bucket) => Object.keys(bucket));
	if (new Set(accounted).size !== accounted.length) throw new Error(`${judge} checkpoint accounts for a source more than once`);
}

function validateBlindingKey(blindingKey) {
	if (!(typeof blindingKey === "string" || Buffer.isBuffer(blindingKey)) || Buffer.byteLength(blindingKey) < 32) {
		throw new Error("blindingKey must contain at least 32 private bytes");
	}
	return blindingKey;
}

function blindHmac(blindingKey, label, value) {
	return createHmac("sha256", blindingKey).update(`${label}\0${value}`).digest("hex");
}

function opaqueId(blindingKey, basisHash, sourceKey) {
	return `case-${blindHmac(blindingKey, "case", `${basisHash}\0${sourceKey}`).slice(0, 16)}`;
}

function basisHashOf(basis) {
	return createHash("sha256").update(stable(basis)).digest("hex");
}

function blindJudges(blindingKey, sourceKey, sol, opus) {
	const swap = Number.parseInt(blindHmac(blindingKey, "judge-order", sourceKey)[0], 16) % 2 === 1;
	const rows = swap ? [["A", "opus", opus], ["B", "sol", sol]] : [["A", "sol", sol], ["B", "opus", opus]];
	return {
		public: rows.map(([label, , value]) => ({ label, quote: value.quote, reasoning: value.reasoning, outcome: value.outcome })),
		private: Object.fromEntries(rows.map(([label, judge]) => [label, judge])),
	};
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactPublicText(value, secrets) {
	let redacted = value
		.replace(/\/tmp\/hydra-traj-[A-Za-z0-9._-]+/g, "<benchmark-workspace>")
		.replace(/Benchmark nonce:\s*[^.\s]+/g, "Benchmark nonce: <hidden>")
		.replace(/\b(?:MAIN|ENUM|F2)(?:-SO2)?\b/g, "<benchmark-arm>")
		.replace(/\b(?:sol|opus)-(?:high|xhigh)\b/gi, "<benchmark-config>")
		.replace(/\b(?:gpt-[a-z0-9.-]+|claude-[a-z0-9.-]+|openai-codex)\b/gi, "<model>");
	for (const secret of secrets) redacted = redacted.replace(new RegExp(escapeRegExp(secret), "g"), "<hidden>");
	return redacted;
}

function redactPublicValue(value, secrets) {
	if (typeof value === "string") return redactPublicText(value, secrets);
	if (Array.isArray(value)) return value.map((item) => redactPublicValue(item, secrets));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactPublicValue(item, secrets)]));
	}
	return value;
}

function publicSecrets(identity, metadata = []) {
	const identitySecrets = [identity.sourceKey, identity.runId, identity.pointKey, identity.pointId, identity.config, identity.arm];
	const executionSecrets = metadata.flatMap((item) => [
		item?.judgeModel,
		item?.judgeProvider,
		item?.model,
		item?.provider,
		item?.shapeSource,
		item?.shapeMember,
	]);
	return [...new Set([...identitySecrets, ...executionSecrets]
		.filter((value) => typeof value === "string" && value.length >= 4))]
		.sort((a, b) => b.length - a.length);
}

function publicCase({ caseId, identity, evidenceRef, evidence, judges, metadata, proposedRecord = undefined }) {
	const result = {
		caseId,
		...(identity.task === undefined ? {} : { task: identity.task }),
		finding: identity.message,
		evidenceRef,
		...(evidence === undefined ? {} : { evidence }),
		judges,
		...(proposedRecord === undefined ? {} : { proposedRecord }),
	};
	return redactPublicValue(result, publicSecrets(identity, metadata));
}

function judgeResult(judgment, invalidOutput) {
	if (judgment) {
		return {
			outcome: normalizeDualCatalogOutcome(judgment),
			quote: rawOutcomeOf(judgment).quote,
			reasoning: rawOutcomeOf(judgment).reasoning,
		};
	}
	return {
		outcome: null,
		quote: null,
		reasoning: invalidOutput?.reason ?? "invalid output after one correction",
		terminal: "invalid-output",
		firstResponse: invalidOutput?.firstResponse ?? null,
		lastResponse: invalidOutput?.lastResponse ?? null,
	};
}

function proposedRecord(identity, outcome) {
	return {
		proposition: identity.message,
		truth: outcome.unmatched.truth,
		severity: outcome.unmatched.severity,
	};
}

function validateOutcomeCatalog(outcome, task, publicCatalogs, label) {
	const catalog = publicCatalogs[task];
	if (!catalog) throw new Error(`${label}: no bound catalog for task ${task ?? "missing"}`);
	const realIds = new Set(catalog.real.map((entry) => entry.id));
	const falseIds = new Set(catalog.false.map((entry) => entry.id));
	for (const id of outcome.realMatches) {
		if (!realIds.has(id)) throw new Error(`${label}: unknown real catalog id ${id}`);
	}
	for (const id of outcome.falseMatches) {
		if (!falseIds.has(id)) throw new Error(`${label}: unknown false catalog id ${id}`);
	}
}

/**
 * Reconcile two complete expanded-2Q judge checkpoints without making semantic
 * decisions on disagreements. The returned `publicQueues` object is safe to
 * hand to a blinded reviewer; source identity exists only in `privateMapping`
 * and the private `decisions` table.
 */
export function reconcileDualCatalogJudgments(sol, opus, { blindingKey, realCatalog, falseCatalog } = {}) {
	validateBlindingKey(blindingKey);
	validateState(sol, "sol");
	validateState(opus, "opus");
	const basis = basisOf(sol.metadata);
	if (stable(basis) !== stable(basisOf(opus.metadata))) {
		throw new Error("judge input metadata differs; do not combine non-identical questions");
	}
	const publicCatalogs = publicCatalogsOf(realCatalog, falseCatalog, basis);

	const solUnjudgeable = Object.fromEntries(sortedKeys(sol.unjudgeable).map((key) => [key, sol.unjudgeable[key]]));
	const opusUnjudgeable = Object.fromEntries(sortedKeys(opus.unjudgeable).map((key) => [key, opus.unjudgeable[key]]));
	if (stable(solUnjudgeable) !== stable(opusUnjudgeable)) {
		throw new Error("unjudgeable records differ; evidence holes must be identical across judges");
	}
	const accountedKeys = (state) => [...new Set([
		...sortedKeys(state.judgments),
		...sortedKeys(state.invalidOutputs),
		...sortedKeys(state.unjudgeable),
	])].sort();
	const solAccounted = accountedKeys(sol);
	const opusAccounted = accountedKeys(opus);
	if (stable(solAccounted) !== stable(opusAccounted)) {
		throw new Error("eligible source keys differ; both judges must account for the same frozen findings");
	}
	const outcomeKeys = solAccounted.filter((sourceKey) => !solUnjudgeable[sourceKey]);

	const basisHash = basisHashOf(basis);
	const packetId = `packet-${blindHmac(blindingKey, "packet", basisHash).slice(0, 16)}`;
	const privateMapping = {};
	const decisions = {};
	const reviewCases = {};
	const agreements = [];
	const disagreements = [];
	const catalogGrowth = [];
	const unresolved = [];
	const invalidOutputs = [];
	const unjudgeable = [];
	const publicMetadata = [sol.metadata, opus.metadata];

	for (const sourceKey of outcomeKeys) {
		const solJudgment = sol.judgments[sourceKey];
		const opusJudgment = opus.judgments[sourceKey];
		const solInvalid = sol.invalidOutputs?.[sourceKey];
		const opusInvalid = opus.invalidOutputs?.[sourceKey];
		const solRecord = solJudgment ?? solInvalid;
		const opusRecord = opusJudgment ?? opusInvalid;
		if (!solRecord || !opusRecord) throw new Error(`${sourceKey}: source is neither judged nor terminal-invalid in one checkpoint`);
		const identity = identityOf(solRecord, sourceKey);
		if (stable(identity) !== stable(identityOf(opusRecord, sourceKey))) {
			throw new Error(`${sourceKey}: finding identity differs between judges`);
		}
		const solBatch = batchFor(sol, sourceKey);
		const opusBatch = batchFor(opus, sourceKey);
		const evidenceHashes = evidenceHashesOf(solRecord, solBatch);
		if (stable(evidenceHashes) !== stable(evidenceHashesOf(opusRecord, opusBatch))) {
			throw new Error(`${sourceKey}: evidence hashes differ between judges`);
		}
		const evidence = evidenceOf(solRecord, solBatch);
		if (stable(evidence) !== stable(evidenceOf(opusRecord, opusBatch))) {
			throw new Error(`${sourceKey}: visible evidence differs between judges`);
		}
		const solResult = judgeResult(solJudgment, solInvalid);
		const opusResult = judgeResult(opusJudgment, opusInvalid);
		if (solResult.outcome) validateOutcomeCatalog(solResult.outcome, identity.task, publicCatalogs, `${sourceKey} Sol`);
		if (opusResult.outcome) validateOutcomeCatalog(opusResult.outcome, identity.task, publicCatalogs, `${sourceKey} Opus`);
		const caseId = opaqueId(blindingKey, basisHash, sourceKey);
		const evidenceRef = `evidence-${blindHmac(blindingKey, "evidence", stable(evidenceHashes)).slice(0, 16)}`;
		if (privateMapping[caseId]) throw new Error(`opaque id collision for ${sourceKey}`);
		const blinded = blindJudges(blindingKey, sourceKey, solResult, opusResult);
		privateMapping[caseId] = {
			sourceKey,
			identity,
			evidenceHashes,
			judgeLabels: blinded.private,
		};

		const decision = {
			caseId,
			sourceKey,
			identity,
			evidenceHashes,
			judges: { sol: solResult, opus: opusResult },
		};
		if (solInvalid || opusInvalid) {
			decision.status = "invalid-output";
			decisions[sourceKey] = decision;
			const reviewCase = publicCase({ caseId, identity, evidenceRef, evidence, judges: blinded.public, metadata: publicMetadata });
			reviewCases[caseId] = reviewCase;
			invalidOutputs.push(reviewCase);
			continue;
		}
		const agreed = outcomeSignature(solResult.outcome) === outcomeSignature(opusResult.outcome);
		if (!agreed) {
			decision.status = "awaiting-human";
			decisions[sourceKey] = decision;
			const reviewCase = publicCase({ caseId, identity, evidenceRef, evidence, judges: blinded.public, metadata: publicMetadata });
			reviewCases[caseId] = reviewCase;
			disagreements.push(reviewCase);
			continue;
		}

		decision.outcome = solResult.outcome;
		if (decision.outcome.realMatches.length || decision.outcome.falseMatches.length) {
			decision.status = "matched";
			agreements.push(caseId);
			reviewCases[caseId] = publicCase({ caseId, identity, evidenceRef, evidence, judges: blinded.public, metadata: publicMetadata });
		} else if (decision.outcome.unmatched.truth === "unclear") {
			decision.status = "unresolved";
			agreements.push(caseId);
			const reviewCase = publicCase({ caseId, identity, evidenceRef, evidence, judges: blinded.public, metadata: publicMetadata });
			reviewCases[caseId] = reviewCase;
			unresolved.push(reviewCase);
		} else {
			decision.status = "settled-unmatched";
			agreements.push(caseId);
			const reviewCase = publicCase({
				caseId,
				identity,
				evidenceRef,
				evidence,
				judges: blinded.public,
				metadata: publicMetadata,
				proposedRecord: proposedRecord(identity, decision.outcome),
			});
			reviewCases[caseId] = reviewCase;
			catalogGrowth.push(reviewCase);
		}
		decisions[sourceKey] = decision;
	}

	for (const sourceKey of sortedKeys(solUnjudgeable)) {
		const record = solUnjudgeable[sourceKey];
		const identity = identityOf(record, sourceKey);
		const evidenceHashes = evidenceHashesOf(record, batchFor(sol, sourceKey));
		const evidence = evidenceOf(record, batchFor(sol, sourceKey));
		const caseId = opaqueId(blindingKey, basisHash, sourceKey);
		const evidenceRef = `evidence-${blindHmac(blindingKey, "evidence", stable(evidenceHashes)).slice(0, 16)}`;
		if (privateMapping[caseId]) throw new Error(`opaque id collision for ${sourceKey}`);
		privateMapping[caseId] = { sourceKey, identity, evidenceHashes, judgeLabels: null };
		decisions[sourceKey] = { caseId, sourceKey, identity, evidenceHashes, status: "unjudgeable", reason: record.reason };
		const reviewCase = publicCase({ caseId, identity, evidenceRef, evidence, judges: [], metadata: publicMetadata });
		reviewCases[caseId] = reviewCase;
		unjudgeable.push(reviewCase);
	}

	const status = disagreements.length ? "awaiting-human" : catalogGrowth.length ? "awaiting-catalog-growth" : "reconciled";
	return {
		schemaVersion: 1,
		status,
		packetId,
		basis,
		basisHash,
		publicCatalogs,
		counts: {
			eligible: solAccounted.length,
			judgeable: outcomeKeys.length,
			agreements: agreements.length,
			disagreements: disagreements.length,
			catalogGrowth: catalogGrowth.length,
			unresolved: unresolved.length,
			invalidOutput: invalidOutputs.length,
			unjudgeable: Object.keys(solUnjudgeable).length,
		},
		agreementCaseIds: agreements,
		reviewCases,
		privateMapping,
		decisions,
		publicQueues: { disagreements, catalogGrowth, unresolved, invalidOutputs, unjudgeable },
		unjudgeable: solUnjudgeable,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const solPath = argOf(args, "--sol", "");
	const opusPath = argOf(args, "--opus", "");
	const outputPath = argOf(args, "--output", "");
	const publicOutputPath = argOf(args, "--public-output", "");
	const blindingKeyPath = argOf(args, "--blinding-key-file", "");
	const realCatalogPath = argOf(args, "--real-catalog", "experiments/golden-dataset.json");
	const falseCatalogPath = argOf(args, "--false-catalog", "experiments/false-positive-catalog.json");
	if (!solPath || !opusPath || !outputPath || !publicOutputPath || !blindingKeyPath) {
		throw new Error("--sol, --opus, --output, --public-output and --blinding-key-file are required");
	}
	const realCatalog = loadRealCatalog(realCatalogPath);
	const falseCatalog = loadFalsePositiveCatalog(falseCatalogPath, {
		tasks: [...new Set(realCatalog.issues.map((issue) => issue.task))],
	});
	const result = reconcileDualCatalogJudgments(
		JSON.parse(readFileSync(solPath, "utf8")),
		JSON.parse(readFileSync(opusPath, "utf8")),
		{ blindingKey: readFileSync(blindingKeyPath), realCatalog, falseCatalog },
	);
	writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
	writeFileSync(publicOutputPath, `${JSON.stringify({
		schemaVersion: result.schemaVersion,
		status: result.status,
		packetId: result.packetId,
		counts: result.counts,
		publicCatalogs: result.publicCatalogs,
		publicQueues: result.publicQueues,
	}, null, 2)}\n`);
	process.stdout.write(`${result.status}: ${result.counts.agreements} agreements, ${result.counts.disagreements} disagreements, ${result.counts.catalogGrowth} catalog candidates\n`);
}
