#!/usr/bin/env node
/** Deterministic cost and one-judge diagnostics for the frozen OpenAI capstone. */

import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { argOf } from "./lib.mjs";
import { deliveredFindings, failedDriverPointKeys } from "./capstone-trajectory-judge-protocol.mjs";

const sum = (values) => values.reduce((total, value) => total + value, 0);
const round = (value, digits = 6) => Number(value.toFixed(digits));
const pointRequestKey = (row) => [row.runId, row.trajectoryId, row.config, row.runIndex, row.requestIndex].join("/");
const pointKey = (row) => [row.runId, row.trajectoryId, row.config, row.pointId].join("/");

export function readRowsGz(path) {
	return gunzipSync(readFileSync(path)).toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function isComparableObservation(row, failedDriverKeys) {
	return row?.kind === "observation" && !row.error && row.valid !== false && row.prefixTokens > 0 &&
		!failedDriverKeys.has(pointRequestKey(row));
}

function rawFindings(row) {
	return deliveredFindings(row, { acceptCacheOnlyInvalid: true });
}

function protocolSummary(observations) {
	const delivered = observations.filter((row) => row.delivery && row.delivery !== "none");
	const counts = delivered.map((row) => rawFindings(row).length);
	const histogram = {};
	for (const count of counts) histogram[count] = (histogram[count] ?? 0) + 1;
	return {
		deliveredResponses: delivered.length,
		findings: sum(counts),
		multiFindingResponses: counts.filter((count) => count > 1).length,
		meanFindingsPerDeliveredResponse: delivered.length > 0 ? round(sum(counts) / delivered.length, 2) : null,
		maxFindingsInResponse: counts.length > 0 ? Math.max(...counts) : 0,
		findingsPerResponseHistogram: histogram,
	};
}

function armCostSummary(observations, driverCost, failedDriverKeys, pairedPointKeys) {
	const comparable = observations.filter((row) => isComparableObservation(row, failedDriverKeys));
	const paired = comparable.filter((row) => pairedPointKeys.has(pointKey(row)));
	const chargedCost = sum(observations.map((row) => row.costTotal ?? row.composedCost ?? 0));
	const comparableCost = sum(comparable.map((row) => row.costTotal ?? row.composedCost ?? 0));
	const pairedCost = sum(paired.map((row) => row.costTotal ?? row.composedCost ?? 0));
	return {
		observations: observations.length,
		comparableObservations: comparable.length,
		pairedComparableObservations: paired.length,
		cacheInvalidObservations: observations.filter((row) => row.valid === false).length,
		failedDriverObservations: observations.filter((row) => failedDriverKeys.has(pointRequestKey(row))).length,
		chargedCost: round(chargedCost),
		chargedCostPerObservation: observations.length > 0 ? round(chargedCost / observations.length) : null,
		chargedObserverDriverPercent: driverCost > 0 ? round((chargedCost / driverCost) * 100, 1) : null,
		comparableCost: round(comparableCost),
		costPerObservation: comparable.length > 0 ? round(comparableCost / comparable.length) : null,
		observerDriverPercent: driverCost > 0 ? round((comparableCost / driverCost) * 100, 1) : null,
		pairedComparableCost: round(pairedCost),
		pairedCostPerObservation: paired.length > 0 ? round(pairedCost / paired.length) : null,
		protocol: protocolSummary(observations),
	};
}

export function summariseProducer(rows) {
	const headers = rows.filter((row) => row.kind === "trajectory-matrix-header");
	if (headers.length !== 1) throw new Error(`expected one trajectory-matrix-header, found ${headers.length}`);
	const header = headers[0];
	const failedDriverKeys = failedDriverPointKeys(rows);
	const tasks = [...new Set(rows.filter((row) => row.trajectoryId).map((row) => row.trajectoryId))].sort();
	const configs = [...new Set(rows.filter((row) => row.config).map((row) => row.config))].sort();
	const arms = [...header.arms];
	const cells = [];
	for (const task of tasks) {
		for (const config of configs) {
			const cellRows = rows.filter((row) => row.trajectoryId === task && row.config === config);
			if (cellRows.length === 0) continue;
			const drivers = cellRows.filter((row) => row.kind === "driver-turn");
			const observations = cellRows.filter((row) => row.kind === "observation");
			const driverCost = sum(drivers.map((row) => row.costTotal ?? 0));
			const byPoint = new Map();
			for (const row of observations) {
				const key = pointKey(row);
				if (!byPoint.has(key)) byPoint.set(key, []);
				byPoint.get(key).push(row);
			}
			const pairedPointKeys = new Set([...byPoint.entries()]
				.filter(([, pointRows]) => arms.every((arm) => pointRows.some((row) => row.arm === arm && isComparableObservation(row, failedDriverKeys))))
				.map(([key]) => key));
			cells.push({
				task,
				config,
				driverTurns: drivers.length,
				driverErrors: drivers.filter((row) => row.error).length,
				driverCost: round(driverCost),
				observationPoints: byPoint.size,
				pairedComparablePoints: pairedPointKeys.size,
				arms: Object.fromEntries(arms.map((arm) => [
					arm,
					armCostSummary(observations.filter((row) => row.arm === arm), driverCost, failedDriverKeys, pairedPointKeys),
				])),
			});
		}
	}
	const observations = rows.filter((row) => row.kind === "observation");
	const drivers = rows.filter((row) => row.kind === "driver-turn");
	const totalDriverCost = sum(drivers.map((row) => row.costTotal ?? 0));
	const armTotals = Object.fromEntries(arms.map((arm) => {
		const summaries = cells.map((cell) => cell.arms[arm]);
		const armObservations = sum(summaries.map((item) => item.observations));
		const comparableObservations = sum(summaries.map((item) => item.comparableObservations));
		const pairedComparableObservations = sum(summaries.map((item) => item.pairedComparableObservations));
		const chargedCost = sum(summaries.map((item) => item.chargedCost));
		const comparableCost = sum(summaries.map((item) => item.comparableCost));
		const pairedComparableCost = sum(summaries.map((item) => item.pairedComparableCost));
		return [arm, {
			observations: armObservations,
			comparableObservations,
			pairedComparableObservations,
			chargedCost: round(chargedCost),
			chargedCostPerObservation: round(chargedCost / armObservations),
			chargedObserverDriverPercent: round((chargedCost / totalDriverCost) * 100, 1),
			comparableCost: round(comparableCost),
			costPerObservation: round(comparableCost / comparableObservations),
			observerDriverPercent: round((comparableCost / totalDriverCost) * 100, 1),
			pairedComparableCost: round(pairedComparableCost),
			pairedCostPerObservation: round(pairedComparableCost / pairedComparableObservations),
			protocol: protocolSummary(observations.filter((row) => row.arm === arm)),
		}];
	}));
	return {
		matrixId: header.matrixId,
		matrixHash: header.matrixHash,
		rows: rows.length - 1,
		producerSpend: round(sum([...drivers, ...observations].map((row) => row.costTotal ?? 0)), 4),
		driverCost: round(totalDriverCost, 4),
		observerCost: round(sum(observations.map((row) => row.costTotal ?? 0)), 4),
		driverErrors: drivers.filter((row) => row.error).map((row) => ({
			task: row.trajectoryId,
			config: row.config,
			runIndex: row.runIndex,
			requestIndex: row.requestIndex,
			error: row.error,
		})),
		protocol: Object.fromEntries(arms.map((arm) => [arm, protocolSummary(observations.filter((row) => row.arm === arm))])),
		armTotals,
		cells,
	};
}

function parseRawJudgeResponse(text) {
	const raw = String(text ?? "").trim();
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = fenced ? fenced[1].trim() : raw;
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

export function summariseSolCheckpoint(state) {
	const judgments = Object.values(state.judgments ?? {});
	const batches = state.batches ?? [];
	const malformedAcceptedBatches = batches.filter((batch) => {
		const parsed = parseRawJudgeResponse(batch.finalResponse);
		return !Array.isArray(parsed?.findings) || parsed.findings.length !== batch.sourceKeys.length ||
			parsed.findings.some((finding, index) => finding?.id !== `j${String(index + 1).padStart(2, "0")}` || !Array.isArray(finding.claims));
	});
	const claimSummary = (items) => {
		const itemClaims = items.flatMap((judgment) => judgment.claims);
		const supported = itemClaims.filter((claim) => claim.centralSupported);
		return {
			findings: items.length,
			atomicClaims: itemClaims.length,
			processOnlyFindings: items.filter((judgment) => judgment.claims.length === 0).length,
			supportedClaims: supported.length,
			unsupportedClaims: itemClaims.filter((claim) => !claim.centralSupported).length,
			supportedClaimsWithUnsupportedExtra: supported.filter((claim) => claim.unsupportedExtra).length,
			supportedUnmatchedClaims: supported.filter((claim) => claim.matches.length === 0).length,
			supportedMultiMatchClaims: supported.filter((claim) => claim.matches.length > 1).length,
			uniqueSupportedCatalogMatches: new Set(supported.flatMap((claim) => claim.matches.map((match) => match.issueId))).size,
		};
	};
	const groups = new Map();
	for (const judgment of judgments) {
		const key = [judgment.task, judgment.config, judgment.arm].join("/");
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(judgment);
	}
	const diagnostics = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, items]) => {
		return {
			key,
			...claimSummary(items),
		};
	});
	const arms = [...new Set(judgments.map((judgment) => judgment.arm))].sort();
	return {
		status: state.status,
		judge: state.metadata?.judge,
		eligibilityPolicy: state.metadata?.eligibilityPolicy,
		expectedFindings: state.metadata?.expectedFindings,
		judgments: judgments.length,
		unjudgeable: Object.keys(state.unjudgeable ?? {}).length,
		batches: batches.length,
		transportFailures: (state.failures ?? []).length,
		recoveredBatches: batches.filter((batch) => batch.recovered).length,
		emptyTransportFailures: (state.failures ?? []).filter((failure) => !failure.firstResponse && !failure.lastResponse).length,
		malformedAcceptedBatches: malformedAcceptedBatches.length,
		...claimSummary(judgments),
		byArm: Object.fromEntries(arms.map((arm) => [arm, claimSummary(judgments.filter((judgment) => judgment.arm === arm))])),
		diagnostics,
	};
}

export function comparisonInput(producer, datasetVersion) {
	return {
		datasetVersion,
		rows: producer.cells.flatMap((cell) => Object.entries(cell.arms).map(([arm, summary]) => ({
			task: cell.task,
			config: cell.config,
			arm,
			costPerObservation: summary.costPerObservation,
			observerDriverPercent: summary.observerDriverPercent,
		}))),
	};
}

export function judgmentsJsonl(state) {
	return `${Object.values(state.judgments ?? {})
		.sort((a, b) => a.sourceKey.localeCompare(b.sourceKey))
		.map((judgment) => JSON.stringify({ metric: "atomic-claims-v1", ...judgment }))
		.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows-gz", "");
	if (!rowsPath) throw new Error("--rows-gz is required");
	const producer = summariseProducer(readRowsGz(rowsPath));
	const judgePath = argOf(args, "--judge", "");
	const judgeState = judgePath ? JSON.parse(readFileSync(judgePath, "utf8")) : null;
	const output = {
		producer,
		sol: judgeState ? summariseSolCheckpoint(judgeState) : null,
	};
	const outputPath = argOf(args, "--output", "");
	if (outputPath) writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
	else process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
	const comparisonPath = argOf(args, "--comparison-output", "");
	if (comparisonPath) {
		const datasetVersion = judgeState ? `provisional ${judgeState.metadata.datasetVersion}` : "pending frozen v2";
		writeFileSync(comparisonPath, `${JSON.stringify(comparisonInput(producer, datasetVersion), null, 2)}\n`);
	}
	const judgmentsPath = argOf(args, "--judgments-output", "");
	if (judgmentsPath) {
		if (!judgeState) throw new Error("--judgments-output requires --judge");
		writeFileSync(judgmentsPath, judgmentsJsonl(judgeState));
	}
}
