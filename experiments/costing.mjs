/**
 * The program's costing: three named bases, one implementation each, and the
 * price table captured and hashed per run so a `pi` refresh cannot silently
 * re-price a frozen wave.
 *
 * Before this module the program priced observations in four places —
 * `trajectory-cost-ab.mjs:153-163` (`pricesFor`), a hardcoded table in
 * `trajectory-cost-invariants.check.mjs:49`, `usage.cost` in
 * `summarize-delivery-context-golden.mjs:281`, and hand arithmetic that exists
 * only as prose at `ANTHROPIC-COST-SWEEP-RESULTS.md:11-16` — and the last of
 * those supplies the number the xhigh verdict and the plan's G1 gate rest on.
 *
 * ## Which basis each results table uses
 *
 * | Table | Basis |
 * |---|---|
 * | `summarize-delivery-context-golden.mjs` `observerCostMean`, every screen doc's "observer cost" column | HARNESS |
 * | `ANTHROPIC-COST-SWEEP-RESULTS.md` "Production-priced, per observation" | PRODUCTION |
 * | `XHIGH-SCREEN-RESULTS.md` / `UNIFIED-API-SCREEN-RESULTS.md` cost columns | HARNESS (the docs disclaim the basis in prose) |
 * | `summarize-trajectory-cost.mjs` R, r(L), T1-T4 | COMPOSED_TRAJECTORY |
 *
 * Cross-basis comparison is invalid: HARNESS bills the arm's contract at
 * cache-WRITE rates against a synthetic prefix, so it overstates the level and
 * (because a longer contract writes more) exaggerates arm deltas.
 */

import { sha16 } from "./fingerprints.mjs";

/**
 * Provider-reported `usage.cost`, exactly as the harness incurred it: synthetic
 * driver prefix, the arm's contract billed at cache-write 1.25x, no production
 * cache riding. `summarize-delivery-context-golden.mjs:356-362` already flags it
 * as non-verdict-carrying; this constant is that disclaimer with a name.
 */
export const HARNESS_BASIS = "harness";

/**
 * What a user pays in production: the driver prefix rides the cache (cache-read
 * rates), the arm's own contract is uncached input, output is output.
 * Operationalized from `ANTHROPIC-COST-SWEEP-RESULTS.md:11-16`.
 */
export const PRODUCTION_BASIS = "production";

/**
 * The trajectory benchmark's single-head economics: every arm charged one M
 * write and credited the M tokens it read, because forking three arms off one
 * driver is a harness artifact. Implemented at
 * `trajectory-cost-ab.mjs:composeObservationCost` — it needs per-point M-write
 * state this module has no access to, so it stays there and reads its prices
 * from here.
 */
export const COMPOSED_TRAJECTORY_BASIS = "composed-trajectory";

export const BASES = Object.freeze([HARNESS_BASIS, PRODUCTION_BASIS, COMPOSED_TRAJECTORY_BASIS]);

/**
 * µ$ per token from the resolved model's own cost table. `cacheWrite1h` is not
 * in the table: Anthropic prices a 1h write at 2x input where the 5m write is
 * 1.25x, and `usage.cacheWrite1h` is a SUBSET of `usage.cacheWrite`
 * (`pi-ai/dist/types.d.ts:256`).
 *
 * `strict: false` returns null instead of throwing, for the run header — a
 * model with no resolvable cost table must not stop a wave from starting; it
 * must be recorded as unpriced.
 */
export function pricesFor(model, { strict = true } = {}) {
	const cost = model?.cost;
	if (!cost || typeof cost.input !== "number") {
		if (strict) throw new Error("model has no cost table");
		return null;
	}
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		cacheWrite1h: cost.input * 2,
	};
}

/**
 * Resolve every requested model's prices into one `{modelId: prices}` table.
 * `resolve` is injected so this module never imports the catalog (which reads
 * `~/.pi/agent/models-store.json`, machine state the checks must not depend on).
 */
export function priceTable(models, resolve) {
	const table = {};
	for (const { provider, id } of models) {
		table[id] = pricesFor(resolve(provider, id), { strict: false });
	}
	return table;
}

/**
 * Identity of the price table a run was measured under. Keys sorted so the hash
 * depends on the prices and not on resolution order. `null` entries (unpriced
 * models) hash too — an unpriced run must not collide with a priced one.
 */
export function pricesHash(table) {
	const sorted = Object.keys(table)
		.sort()
		.map((id) => [id, table[id] ?? null]);
	return sha16(JSON.stringify(sorted));
}

/** Flat token counts from a pi-ai usage object or a producer row's `usage`. */
export function flatUsage(usage) {
	return {
		input: usage?.input ?? 0,
		output: usage?.output ?? 0,
		reasoning: usage?.reasoning ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		cacheWrite1h: usage?.cacheWrite1h ?? 0,
		cost: typeof usage?.cost === "number" ? usage.cost : (usage?.cost?.total ?? 0),
	};
}

/** Straight price of a measured usage, in dollars. The HARNESS basis, recomputed. */
export function rawCost(usage, prices) {
	const write5m = Math.max(0, usage.cacheWrite - (usage.cacheWrite1h ?? 0));
	return (
		(usage.cacheRead * prices.cacheRead +
			write5m * prices.cacheWrite +
			(usage.cacheWrite1h ?? 0) * prices.cacheWrite1h +
			usage.input * prices.input +
			usage.output * prices.output) /
		1e6
	);
}

/**
 * PRODUCTION basis for one observation.
 *
 *   cost = driverTokens * cacheRead + (readable - driverTokens) * input
 *        + output * output
 *
 * where `readable = input + cacheRead + cacheWrite` is everything the call was
 * billed for on the way in, and `driverTokens` is the prefix that rides the
 * driver's cache in production. The remainder is the arm's own contract, which
 * production pays as uncached input on every observation.
 */
export function productionCost(usage, prices, driverTokens) {
	const readable = usage.input + usage.cacheRead + usage.cacheWrite;
	const promptTokens = Math.max(0, readable - driverTokens);
	return (driverTokens * prices.cacheRead + promptTokens * prices.input + usage.output * prices.output) / 1e6;
}

/**
 * "driver tokens = max cacheRead per case" (`ANTHROPIC-COST-SWEEP-RESULTS.md:14`)
 * is ambiguous about the scope of the max, and the two readings do not agree.
 * Measured against the frozen sweep (`artifacts/2026-07-31-anthropic-cost-sweep/`,
 * last-wins dedup, paired cells only), reproducing the published table:
 *
 *   scope "all-models"  15 of 16 published cells reproduce to 4 decimals
 *                       (the exception: sonnet-xhigh A0 computes $0.004547
 *                       against a published $0.0046)
 *   scope "per-model"   11 of 16 cells miss, sonnet worst — $0.0043 against a
 *                       published $0.0030, because sonnet's own rows sit below
 *                       the 1024-token cache floor and 44 of 48 read zero
 *
 * So the published table imports opus/fable driver token counts into sonnet.
 * That is a load-bearing modeling decision, stated in one clause of prose and
 * implemented nowhere until now: "all-models" is the default because it is what
 * the frozen tables were computed under, NOT because it is obviously right.
 *
 * The two scopes coincide on a single-config file: "all-models" maxes over
 * whatever models are POOLED IN `rows`, so on a one-model screen it is
 * per-model by construction. The scope name alone does not tell a reader which
 * they got — read it together with the model mix of the input.
 */
export const DRIVER_TOKEN_SCOPES = Object.freeze(["all-models", "per-model"]);

export function driverTokensByCase(rows, { scope = "all-models" } = {}) {
	if (!DRIVER_TOKEN_SCOPES.includes(scope)) throw new Error(`unknown driver-token scope: ${scope}`);
	const max = new Map();
	for (const row of rows) {
		if (row.error) continue;
		const key = scope === "all-models" ? row.case : `${row.model}/${row.case}`;
		max.set(key, Math.max(max.get(key) ?? 0, row.usage?.cacheRead ?? 0));
	}
	return {
		scope,
		tokensFor: (row) => max.get(scope === "all-models" ? row.case : `${row.model}/${row.case}`) ?? 0,
	};
}

/**
 * One priced observation on a named basis. `prices` is the table captured in the
 * run header; a row whose model is unpriced returns null rather than a zero that
 * would quietly drag a mean down.
 */
export function priceRow(row, { basis, prices, driverTokens = null }) {
	const usage = flatUsage(row.usage);
	if (basis === HARNESS_BASIS) {
		const table = prices?.[row.modelId];
		return table ? rawCost(usage, table) : (typeof row.usage?.cost === "number" ? row.usage.cost : null);
	}
	if (basis === PRODUCTION_BASIS) {
		const table = prices?.[row.modelId];
		if (!table || driverTokens === null) return null;
		return productionCost(usage, table, driverTokens);
	}
	throw new Error(`priceRow: basis ${basis} is not priced here (see COMPOSED_TRAJECTORY_BASIS)`);
}

/**
 * Frozen opus-5 prices for offline checks. The invariant suites must not read
 * `~/.pi/agent/models-store.json` — machine state outside git — so they assert
 * against this instead of a live `pricesFor()`.
 */
export const FIXTURE_PRICES = Object.freeze({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 });
