#!/usr/bin/env node
/**
 * Analysis for the trajectory cost benchmark. Reads only the rows
 * `trajectory-cost-ab.mjs` wrote — cost and quality come from the same rows
 * (spec Q0d), and any separately produced cost number voids the joint table.
 *
 * What it prints, in the order the spec evaluates it:
 *   validity   Q0c cache floor, rows that failed a live assertion, dropped cells
 *   R          Σ composedCost(arm) / Σ driver costTotal, per (trajectory, config)
 *   r(L)       the per-point curve and the T1 structure fit
 *   T1-T4      the pre-registered cost rules
 *   tax        injection tax, including and excluding repeat deliveries
 *   joint      the quality-per-dollar table skeleton (quality columns are filled
 *              from the judge streams; they print as `pending` until then)
 *
 * Two things it refuses to do quietly:
 *
 * - **N_obs/T is 1.00 here by construction.** A live fork observes every
 *   assistant message except a run's first, plus one run-end per run, which is
 *   exactly one observation per driver request. Production sheds ~20% of that
 *   ceiling to the conflating scheduler (0.74 mean / 0.83 median over 559 real
 *   hydra calls, `wave8-mechanics.md:14`), and the mechanics tables that produced
 *   T2's 25-45% band are parameterized at N_obs/T = 0.80. So the measured R here
 *   sits ~1.25x above that band's basis. Every R is printed alongside its
 *   conflation-discounted forms at 0.74 and 0.83, and T2 is evaluated against
 *   all three with the basis named. Picking one silently would decide the
 *   verdict by an enumeration artifact.
 * - **Delivered-message token counts are character estimates** (~4 chars/token),
 *   not tokenizer output. The injection tax is therefore an estimate and is
 *   labelled as one everywhere it appears.
 *
 * Usage:
 *   node experiments/summarize-trajectory-cost.mjs --rows rows.jsonl
 *   node experiments/summarize-trajectory-cost.mjs --rows rows.jsonl --json out.json
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { argOf } from "./lib.mjs";
import { cellsOf, deriveGroundTruth, pointsOf, readRows } from "./trajectory-ground-truth.mjs";
import { taskById } from "./trajectory-cost-tasks.mjs";
import { ARMS } from "./trajectory-cost-ab.mjs";

/** Production's measured observations per driver assistant turn, per head. */
export const CONFLATION_FACTORS = Object.freeze({ mean: 0.74, median: 0.83 });
export const T1_TOLERANCE = 0.15;
/**
 * Registered analyst operationalization (spec §Registered analyst
 * operationalizations): "fits within ±15%" is scored as at least half of the
 * piggyback points inside tolerance, with the slope required positive.
 */
export const T1_MIN_WITHIN_SHARE = 0.5;
export const T2_BAND = Object.freeze([0.25, 0.45]);
/** One-sided: F above MAIN by more than this breaches; F below MAIN is a win. */
export const T3_MAX_SPREAD_PP = 5;
export const Q0C_HIT_FLOOR = 90;
/** Pre-registered pilot abort gate. */
export const PILOT_MIN_DRIVER_REQUESTS = 15;
export const PILOT_MIN_FINAL_CONTEXT = 25_000;
/** Characters per token, for the injection-tax estimate only. */
export const CHARS_PER_TOKEN = 4;

const sum = (values) => values.reduce((total, value) => total + value, 0);
const mean = (values) => (values.length === 0 ? 0 : sum(values) / values.length);

export function groupCell(cell) {
	const driverTurns = cell.rows.filter((row) => row.kind === "driver-turn");
	const observations = cell.rows.filter((row) => row.kind === "observation");
	const start = cell.rows.find((row) => row.kind === "cell-start");
	const end = cell.rows.find((row) => row.kind === "cell-end");
	return { ...cell, driverTurns, observations, start, end };
}

/**
 * R(arm, trajectory) and its inputs. The primary denominator is the driver cost
 * the provider reported (spec: "Σ_turns driver costTotal"); `costComputed` from
 * the model's own price table is carried alongside as a consistency check, and
 * takes over only if the provider reported nothing, which is stated when it
 * happens.
 */
export function cellRatios(cell) {
	const driverReported = sum(cell.driverTurns.map((row) => row.costTotal ?? 0));
	const driverComputed = sum(cell.driverTurns.map((row) => row.costComputed ?? 0));
	const usedComputed = driverReported <= 0;
	const driverCost = usedComputed ? driverComputed : driverReported;

	// A point counts for every arm or for none. Rows are invalidated
	// individually (`trajectory-cost-ab.mjs` fails the row, not the point), so an
	// arm whose call errored loses that point while the other two keep it — and R
	// would then divide different point sets by the same driver denominator, with
	// the discrepancy silent. `bootstrapContrast` already requires both arms at a
	// pointId, so without this the point estimate and its CI would be computed on
	// different bases.
	const armsPresent = new Set(cell.observations.map((row) => row.arm));
	const validByPoint = new Map();
	for (const row of cell.observations) {
		if (!validByPoint.has(row.pointId)) validByPoint.set(row.pointId, new Set());
		if (row.valid) validByPoint.get(row.pointId).add(row.arm);
	}
	const completePoints = new Set(
		[...validByPoint.entries()].filter(([, valid]) => valid.size === armsPresent.size).map(([pointId]) => pointId),
	);
	const droppedPoints = [...validByPoint.keys()].filter((pointId) => !completePoints.has(pointId));

	const arms = new Map();
	for (const row of cell.observations) {
		if (!arms.has(row.arm)) arms.set(row.arm, { arm: row.arm, valid: [], invalid: [] });
		const usable = row.valid && completePoints.has(row.pointId);
		arms.get(row.arm)[usable ? "valid" : "invalid"].push(row);
	}
	// Fixed arm order (MAIN first, the baseline), never the random firing order
	// the rows were written in: a table whose columns move between cells invites
	// exactly the misreading the contrast is supposed to prevent.
	const perArm = [...arms.values()]
		.sort((a, b) => ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm))
		.map((entry) => {
			const composed = sum(entry.valid.map((row) => row.composedCost));
			const ratio = driverCost > 0 ? composed / driverCost : null;
			return {
				arm: entry.arm,
				points: entry.valid.length,
				invalidPoints: entry.invalid.length,
				composedCost: composed,
				rawCost: sum(entry.valid.map((row) => row.rawCost)),
				ratio,
				ratioAt: Object.fromEntries(
					Object.entries(CONFLATION_FACTORS).map(([label, factor]) => [label, ratio === null ? null : ratio * factor]),
				),
				meanHitRatio: mean(entry.valid.map((row) => row.hitRatio)),
				meanOutput: mean(entry.valid.map((row) => row.output)),
				meanReasoning: mean(entry.valid.map((row) => row.reasoning)),
				meanInput: mean(entry.valid.map((row) => row.input)),
			};
		});
	return {
		key: cell.key,
		trajectoryId: cell.trajectoryId,
		config: cell.config,
		driverCost,
		driverCostReported: driverReported,
		driverCostComputed: driverComputed,
		usedComputedDenominator: usedComputed,
		driverRequests: cell.driverTurns.length,
		droppedPoints,
		droppedPointCount: droppedPoints.length,
		observationPoints: new Set(cell.observations.map((row) => row.pointId)).size,
		obsPerRequest: cell.driverTurns.length > 0 ? new Set(cell.observations.map((row) => row.pointId)).size / cell.driverTurns.length : 0,
		meanPrefix: mean(cell.driverTurns.map((row) => row.prefixTokens)),
		finalPrefix: cell.driverTurns.at(-1)?.prefixTokens ?? 0,
		meanDriverOutput: mean(cell.driverTurns.map((row) => row.output)),
		meanDriverWrite: mean(cell.driverTurns.map((row) => row.cacheWrite)),
		perArm,
	};
}

/**
 * The per-point curve and T1's structure fit. Both sides of the residual use the
 * registered three-term denominator (see below); `measuredFullPrice` carries the
 * provider-priced ratio alongside, which is the basis R uses. The two differ by
 * the driver's uncached input and are printed as the different numbers they are.
 *
 * Fitted on piggyback points only:
 * the pre-registered form `(0.5L + 5P + 25O)/(0.5L + 6.25D + 25Ddrv)` has no
 * write term in its numerator, which is the piggyback shape (`utils.ts:786-806`
 * — a `[prompt]` tail moves no marker). Run-end points carry the composed M
 * write and are reported separately rather than fitted against a formula that
 * does not describe them.
 */
export function pointCurve(cell, prices) {
	const driverByRequest = new Map(cell.driverTurns.map((row) => [row.requestIndex, row]));
	const dropped = new Set(cellRatios(cell).droppedPoints);
	return cell.observations
		.filter((row) => row.valid && !dropped.has(row.pointId))
		.map((row) => {
			const driver = driverByRequest.get(row.requestIndex);
			if (!driver) return null;
			const L = row.cacheRead;
			// T1's residual must not charge the cost model for a term the registered
			// form does not have. `predicted`'s denominator is the three-term
			// `0.5L + 6.25D + 25D_drv`; the provider's full price also carries the
			// driver's uncached input, so dividing a measured ratio built on
			// costTotal by a prediction built on three terms would inflate the
			// residual by exactly that input. Both sides use the three-term
			// denominator here. `measuredFullPrice` keeps the user-facing basis (what
			// the driver actually cost) alongside, and R itself is unchanged.
			const threeTermDenominator =
				L * prices.cacheRead + driver.cacheWrite * prices.cacheWrite + driver.output * prices.output;
			const driverCost = driver.costTotal > 0 ? driver.costTotal : driver.costComputed;
			const measured = threeTermDenominator > 0 ? (row.composedCost * 1e6) / threeTermDenominator : null;
			const measuredFullPrice = driverCost > 0 ? row.composedCost / driverCost : null;
			const predictedNumerator = L * prices.cacheRead + row.input * prices.input + row.output * prices.output;
			const predicted = threeTermDenominator > 0 ? predictedNumerator / threeTermDenominator : null;
			return {
				pointId: row.pointId,
				pointIndex: row.pointIndex,
				pointKind: row.pointKind,
				arm: row.arm,
				L,
				prefixTokens: row.prefixTokens,
				armInput: row.input,
				armOutput: row.output,
				driverOutput: driver.output,
				driverWrite: driver.cacheWrite,
				measured,
				measuredFullPrice,
				predicted,
				relativeError: measured !== null && predicted ? (measured - predicted) / predicted : null,
			};
		})
		.filter(Boolean);
}

export function leastSquaresSlope(xs, ys) {
	if (xs.length < 2) return null;
	const mx = mean(xs);
	const my = mean(ys);
	const denominator = sum(xs.map((x) => (x - mx) ** 2));
	return denominator === 0 ? null : sum(xs.map((x, index) => (x - mx) * (ys[index] - my))) / denominator;
}

export function evaluateT1(curve) {
	const piggyback = curve.filter((point) => point.pointKind === "piggyback" && point.relativeError !== null);
	const within = piggyback.filter((point) => Math.abs(point.relativeError) <= T1_TOLERANCE);
	const slope = leastSquaresSlope(piggyback.map((point) => point.L), piggyback.map((point) => point.measured));
	const quartiles = [0, 1, 2, 3].map((index) => {
		const sorted = [...piggyback].sort((a, b) => a.L - b.L);
		const size = Math.ceil(sorted.length / 4) || 1;
		const bin = sorted.slice(index * size, (index + 1) * size);
		return { bin: index + 1, n: bin.length, meanL: mean(bin.map((p) => p.L)), meanRatio: mean(bin.map((p) => p.measured)) };
	});
	return {
		points: piggyback.length,
		withinTolerance: within.length,
		share: piggyback.length > 0 ? within.length / piggyback.length : 0,
		slopePerToken: slope,
		rises: slope !== null && slope > 0,
		quartiles,
		verdict:
			piggyback.length === 0
				? "no data"
				: slope !== null && slope > 0 && within.length / piggyback.length >= T1_MIN_WITHIN_SHARE
					? "T1 holds: the ratio rises with prefix length and the fit is within tolerance for most points"
					: "T1 BREACHED: the cost model does not describe the curve — quote no point estimate",
	};
}

/**
 * Paired bootstrap of an arm contrast over points; pairing is byte-exact.
 * Restricted to the same complete-point set `cellRatios` uses, so the point
 * estimate and its interval are computed on one basis.
 */
export function bootstrapContrast(cell, armA, armB, iterations = 2000) {
	const dropped = new Set(cellRatios(cell).droppedPoints);
	const byPoint = new Map();
	for (const row of cell.observations) {
		if (!row.valid || dropped.has(row.pointId)) continue;
		if (!byPoint.has(row.pointId)) byPoint.set(row.pointId, {});
		byPoint.get(row.pointId)[row.arm] = row.composedCost;
	}
	const pairs = [...byPoint.values()].filter((point) => point[armA] !== undefined && point[armB] !== undefined);
	if (pairs.length === 0) return null;
	const driverCost = sum(cell.driverTurns.map((row) => (row.costTotal > 0 ? row.costTotal : row.costComputed)));
	const statistic = (sample) => (sum(sample.map((point) => point[armB] - point[armA])) / driverCost) * 100;
	const observed = statistic(pairs);
	const draws = [];
	for (let iteration = 0; iteration < iterations; iteration++) {
		const sample = Array.from({ length: pairs.length }, () => pairs[Math.floor(Math.random() * pairs.length)]);
		draws.push(statistic(sample));
	}
	draws.sort((a, b) => a - b);
	return {
		pairs: pairs.length,
		observedPp: observed,
		ci95: [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]],
	};
}

const normalizeMessage = (text) => (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Injection tax, per wave8-quality.md §0: what a delivery would have cost the
 * driver had it been routed — `delivered tokens x remaining driver requests x
 * cache-read price + one cache write`. Reported including and excluding repeat
 * deliveries (spec amendment: repeat behaviour is descriptive only, and the tax
 * must be readable without it). Repeats are the deterministic screen — the same
 * arm delivering a message it already delivered in this cell — not a judgment.
 */
export function injectionTax(cell, prices) {
	const totalRequests = cell.driverTurns.length;
	const perArm = new Map();
	const seen = new Map();
	for (const row of cell.observations.filter((item) => item.valid).sort((a, b) => a.pointIndex - b.pointIndex)) {
		if (!perArm.has(row.arm)) perArm.set(row.arm, { arm: row.arm, deliveries: 0, repeats: 0, all: 0, excludingRepeats: 0 });
		const entry = perArm.get(row.arm);
		const action = row.decision?.action ?? null;
		if (!action || action === "noop" || !row.decision?.message) continue;
		const key = `${row.arm}|${normalizeMessage(row.decision.message)}`;
		const isRepeat = seen.has(key);
		seen.set(key, true);
		const tokens = Math.ceil((row.decision.message.length + 24) / CHARS_PER_TOKEN);
		const remaining = Math.max(0, totalRequests - 1 - row.requestIndex);
		const cost = (tokens * remaining * prices.cacheRead + tokens * prices.cacheWrite) / 1e6;
		entry.deliveries++;
		entry.all += cost;
		if (isRepeat) entry.repeats++;
		else entry.excludingRepeats += cost;
	}
	return [...perArm.values()].sort((a, b) => ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm));
}

function fmt(value, digits = 4) {
	return value === null || value === undefined ? "-" : Number(value).toFixed(digits);
}

function pct(value, digits = 1) {
	return value === null || value === undefined ? "-" : `${(value * 100).toFixed(digits)}%`;
}

function summarize(rowsPath) {
	const rows = readRows(rowsPath);
	const cells = cellsOf(rows).map(groupCell);
	if (cells.length === 0) throw new Error("no completed cells in the rows file");
	const report = { cells: [], contrasts: [], generatedAt: Date.now() };

	console.log("# Trajectory cost benchmark\n");
	console.log("## Validity (Q0c, live assertions)\n");
	console.log("cell                          points  invalid  meanHit  denominator");
	for (const cell of cells) {
		const invalid = cell.observations.filter((row) => !row.valid);
		const hit = mean(cell.observations.filter((row) => row.valid).map((row) => row.hitRatio));
		const ratios = cellRatios(cell);
		console.log(
			`${cell.key.padEnd(30)}${String(cell.observations.length).padEnd(8)}${String(invalid.length).padEnd(9)}` +
				`${hit.toFixed(1).padEnd(9)}${cell.driverTurns.length} driver turns`,
		);
		if (hit < Q0C_HIT_FLOOR) console.log(`  !! Q0C BREACH: mean hit ratio ${hit.toFixed(1)}% below the ${Q0C_HIT_FLOOR}% floor — rows are invalid, not noisy`);
		for (const row of invalid.slice(0, 8)) {
			console.log(`  !! ${row.pointId} ${row.arm}: ${(row.assertionFailures ?? []).join("; ")}`);
		}
		if (ratios.droppedPointCount > 0) {
			console.log(
				`  dropped ${ratios.droppedPointCount} point(s) from every arm (a point counts for all arms or none): ` +
					`${ratios.droppedPoints.slice(0, 6).join(", ")}${ratios.droppedPointCount > 6 ? ", …" : ""}`,
			);
		}
		// Pre-registered pilot abort gate (spec §Execution gates), evaluated rather
		// than left as an unsurfaced field.
		const requestsOk = ratios.driverRequests >= PILOT_MIN_DRIVER_REQUESTS;
		const contextOk = ratios.finalPrefix >= PILOT_MIN_FINAL_CONTEXT;
		console.log(
			`  PILOT GATE: ${ratios.driverRequests} driver requests (>=${PILOT_MIN_DRIVER_REQUESTS}: ${requestsOk ? "pass" : "FAIL"}), ` +
				`final context ${Math.round(ratios.finalPrefix)} (>=${PILOT_MIN_FINAL_CONTEXT}: ${contextOk ? "pass" : "FAIL"})` +
				`${requestsOk && contextOk ? "" : " — the spec aborts and redesigns on a FAIL"}`,
		);
	}

	console.log("\n## R(arm, trajectory) = Σ composedCost / Σ driver cost\n");
	console.log(
		"cell                          arm    points  obs$      driver$   R        R@0.83   R@0.74   meanL    D_drv  O_arm",
	);
	for (const cell of cells) {
		const prices = cell.start?.prices;
		const ratios = cellRatios(cell);
		report.cells.push(ratios);
		for (const arm of ratios.perArm) {
			console.log(
				`${cell.key.padEnd(30)}${arm.arm.padEnd(7)}${String(arm.points).padEnd(8)}` +
					`${fmt(arm.composedCost).padEnd(10)}${fmt(ratios.driverCost).padEnd(10)}` +
					`${pct(arm.ratio).padEnd(9)}${pct(arm.ratioAt.median).padEnd(9)}${pct(arm.ratioAt.mean).padEnd(9)}` +
					`${Math.round(ratios.meanPrefix).toString().padEnd(9)}${Math.round(ratios.meanDriverOutput).toString().padEnd(7)}${Math.round(arm.meanOutput)}`,
			);
		}
		if (ratios.usedComputedDenominator) {
			console.log("  !! the provider reported no driver cost; the denominator is this harness's price table");
		}
		console.log(
			`  N_obs/T = ${ratios.obsPerRequest.toFixed(2)} (live fork enumerates the ceiling; production measures 0.74 mean / 0.83 median)`,
		);

		if (prices) {
			const curve = pointCurve(cell, prices);
			const t1 = evaluateT1(curve);
			report.cells.at(-1).t1 = t1;
			report.cells.at(-1).curve = curve;
			console.log(`  T1 fit (piggyback n=${t1.points}): within ±15% ${t1.withinTolerance}/${t1.points}, slope ${t1.slopePerToken === null ? "-" : t1.slopePerToken.toExponential(2)}/token`);
			console.log(`     L quartiles: ${t1.quartiles.map((q) => `${Math.round(q.meanL)}→${pct(q.meanRatio)}`).join("  ")}`);
			console.log(`     ${t1.verdict}`);

			const tax = injectionTax(cell, prices);
			report.cells.at(-1).injectionTax = tax;
			for (const entry of tax) {
				console.log(
					`  injection tax (estimate) ${entry.arm}: ${entry.deliveries} deliveries (${entry.repeats} repeat) ` +
						`$${fmt(entry.all)} incl / $${fmt(entry.excludingRepeats)} excl repeats ` +
						`= ${pct(entry.all / ratios.driverCost)} / ${pct(entry.excludingRepeats / ratios.driverCost)} of driver`,
				);
			}
		}
	}

	console.log("\n## Pre-registered rules\n");
	for (const cell of cells) {
		const ratios = report.cells.find((entry) => entry.key === cell.key);
		const main = ratios.perArm.find((arm) => arm.arm === "MAIN");
		const footer = ratios.perArm.find((arm) => arm.arm === "F");
		const json = ratios.perArm.find((arm) => arm.arm === "J");
		console.log(`### ${cell.key}`);
		if (main?.ratio != null) {
			const bases = [
				["as measured (N_obs/T=1.00)", main.ratio],
				["x0.83 (production median)", main.ratioAt.median],
				["x0.74 (production mean)", main.ratioAt.mean],
			];
			for (const [label, value] of bases) {
				const inBand = value >= T2_BAND[0] && value <= T2_BAND[1];
				console.log(`  T2 ${label}: MAIN ${pct(value)} — ${inBand ? "inside" : "OUTSIDE"} the 25-45% band ` +
					`(L=${Math.round(ratios.meanPrefix)}, D_drv=${Math.round(ratios.meanDriverOutput)})`);
			}
			console.log("      the point estimate is never to be quoted without L and driver output alongside");
		}
		if (main?.ratio != null && footer?.ratio != null) {
			const spreadPp = (footer.ratio - main.ratio) * 100;
			const contrast = bootstrapContrast(cell, "MAIN", "F");
			if (contrast) report.contrasts.push({ key: cell.key, armA: "MAIN", armB: "F", ...contrast });
			// One-sided, as registered: the rule is `F - MAIN <= 5pp`. F cheaper than
			// MAIN is a win, not a breach, and an absolute value would print it as one.
			const t3 =
				spreadPp > T3_MAX_SPREAD_PP
					? `ABOVE the ${T3_MAX_SPREAD_PP}pp bound: the contract premium is material at session scale`
					: spreadPp < 0
						? `within the ${T3_MAX_SPREAD_PP}pp bound — and below MAIN, i.e. F is the cheaper arm here`
						: `within the ${T3_MAX_SPREAD_PP}pp bound`;
			console.log(
				`  T3 F-MAIN = ${spreadPp.toFixed(2)}pp of driver cost ` +
					`${contrast ? `(bootstrap 95% CI ${contrast.ci95.map((value) => value.toFixed(2)).join(" .. ")}, n=${contrast.pairs} paired points)` : ""} — ${t3}`,
			);
			if (json?.ratio != null) {
				const between = (json.ratio - main.ratio) * (footer.ratio - json.ratio) >= 0;
				console.log(`      J ${pct(json.ratio)} ${between ? "sits between MAIN and F as registered" : "does NOT sit between MAIN and F"}`);
			}
		}
	}

	const byTrajectory = new Map();
	for (const entry of report.cells) {
		if (!byTrajectory.has(entry.trajectoryId)) byTrajectory.set(entry.trajectoryId, new Map());
		byTrajectory.get(entry.trajectoryId).set(entry.config, entry);
	}
	console.log("\n  T4 (config): does the ratio fall at xhigh, driven by the driver's output?");
	for (const [trajectory, configs] of byTrajectory) {
		const high = configs.get("opus-high");
		const xhigh = configs.get("opus-xhigh");
		if (!high || !xhigh) continue;
		for (const armName of ["MAIN", "J", "F"]) {
			const a = high.perArm.find((arm) => arm.arm === armName);
			const b = xhigh.perArm.find((arm) => arm.arm === armName);
			if (!a || !b) continue;
			console.log(
				`    ${trajectory} ${armName}: high ${pct(a.ratio)} → xhigh ${pct(b.ratio)} ` +
					`(${b.ratio < a.ratio ? "falls, as registered" : "RISES, against T4"}); ` +
					`driver output ${Math.round(high.meanDriverOutput)} → ${Math.round(xhigh.meanDriverOutput)}, ` +
					`observer output ${Math.round(a.meanOutput)} → ${Math.round(b.meanOutput)}`,
			);
		}
	}

	console.log("\n## Corpus validity and ground truth (Q0a)\n");
	for (const cell of cells) {
		const derived = deriveGroundTruth(pointsOf(cell), taskById(cell.trajectoryId).defects);
		report.cells.find((entry) => entry.key === cell.key).groundTruth = {
			defects: derived.defects.map(({ timeline, ...rest }) => rest),
			quietSpans: derived.quietSpans,
		};
		console.log(
			`${cell.key}: quiet spans ${derived.quietSpans.map((span) => `${span.from}-${span.to}(${span.length})`).join(" ") || "none"}; ` +
				`defects with a liveness window ${derived.defects.filter((defect) => defect.firstVisible !== null).length}/${derived.defects.length}; ` +
				`payload/file disagreements ${derived.defects.filter((defect) => !defect.agrees).map((defect) => defect.id).join(",") || "none"}`,
		);
	}

	console.log("\n## Joint quality per dollar (skeleton; quality rows fill from the judge streams)\n");
	for (const cell of cells) {
		const ratios = report.cells.find((entry) => entry.key === cell.key);
		const arms = ratios.perArm.map((arm) => arm.arm);
		const tax = new Map((ratios.injectionTax ?? []).map((entry) => [entry.arm, entry]));
		const line = (label, valueFor) => console.log(`${label.padEnd(38)}${arms.map((arm) => String(valueFor(arm)).padEnd(14)).join("")}`);
		console.log(`### ${cell.key}\n${"row".padEnd(38)}${arms.map((arm) => arm.padEnd(14)).join("")}`);
		line("observer $ / driver $", (arm) => pct(ratios.perArm.find((entry) => entry.arm === arm).ratio));
		line("observer $", (arm) => `$${fmt(ratios.perArm.find((entry) => entry.arm === arm).composedCost)}`);
		line("marginal $ vs MAIN", (arm) => {
			const main = ratios.perArm.find((entry) => entry.arm === "MAIN");
			const value = ratios.perArm.find((entry) => entry.arm === arm);
			return main ? `$${fmt(value.composedCost - main.composedCost)}` : "-";
		});
		line("injection tax $ (est, incl repeats)", (arm) => (tax.has(arm) ? `$${fmt(tax.get(arm).all)}` : "-"));
		line("injection tax $ (est, excl repeats)", (arm) => (tax.has(arm) ? `$${fmt(tax.get(arm).excludingRepeats)}` : "-"));
		line("deliveries", (arm) => (tax.has(arm) ? tax.get(arm).deliveries : 0));
		line("mean cache-read share", (arm) => `${ratios.perArm.find((entry) => entry.arm === arm).meanHitRatio.toFixed(1)}%`);
		for (const label of [
			"planted defects surfaced / live (S1)",
			"median latency in points (S1)",
			"false interrupts / trajectory (S5)",
			"unsupportedExtra rate (S2)",
			"improper repeats (S3, descriptive)",
			"preference win rate (S4)",
			"unplanted real finds (S5)",
			"marginal $ per additional issue",
		]) {
			line(label, () => "pending");
		}
		console.log("");
	}
	console.log(
		"No composite quality score is computed, false interrupts stay their own column, and marginal $ per additional\n" +
			"issue is printed with raw counts and never divided through a non-positive denominator (spec, §Quality).",
	);

	return report;
}

async function main() {
	const args = process.argv.slice(2);
	const rowsPath = argOf(args, "--rows", "");
	const jsonPath = argOf(args, "--json", "");
	if (!rowsPath) throw new Error("--rows is required");
	const report = summarize(rowsPath);
	if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(report, null, "\t")}\n`);
}

export { summarize };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
