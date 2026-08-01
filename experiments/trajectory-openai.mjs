#!/usr/bin/env node
/**
 * OpenAI (openai-codex) support for the trajectory benchmark.
 *
 * The trajectory harness was Anthropic-only for a structural reason: a captured
 * driver payload IS an Anthropic Messages request, and `mergeObservationPayload`
 * is typed for it. Replaying that against GPT is impossible. Measuring an arm on
 * OpenAI therefore needs a REAL codex driver run, and observations packaged the
 * way production packages them.
 *
 * EVERYTHING HERE MIRRORS PRODUCTION. Nothing is invented:
 *
 * 1. HANDOFF SPLIT. `usesSplitObservationHandoff` (`utils.ts:361-365`) returns
 *    true for `openai-codex-responses`, so a judge head sends the raw lens as
 *    the user prompt and the contract as a separate DEVELOPER message
 *    (`index.ts:483-492`). Anthropic keeps one combined user prompt. The split
 *    is entitlement-forced, not a preference — see the comment at utils.ts:353.
 * 2. MERGE. `mergeOpenAIObservationPayload` (`utils.ts:900-928`) appends the
 *    tail to `captured.input`, strips prompt-cache breakpoints from the tail,
 *    and splices the developer envelope immediately AFTER the user prompt.
 * 3. CACHE SHARING. Production passes the DRIVER's session id as the codex
 *    cache key so observations ride the driver's prefix cache
 *    (`index.ts:827-844`); losing it means paying the driver context once per
 *    observation. Both driver and observations therefore use one sessionId and
 *    the websocket transport.
 *
 * WHAT DOES NOT PORT, and what replaces it. Anthropic's cache assertions rest
 * on explicit `cache_control` markers: piggyback writes nothing, the run-end
 * writer/reader pair differ by exactly |M|. OpenAI has no markers — the prefix
 * cache is automatic and keyed by (prefix, prompt_cache_key). So:
 *   - the cache-read FLOOR ports directly and is the assertion that matters
 *     (it is what makes every dollar figure meaningful);
 *   - the writer/reader M-delta does NOT exist and is not asserted;
 *   - `cacheWrite` is reported by pi-ai from `cache_write_tokens`
 *     (`openai-responses-shared.js:419`) but OpenAI does not bill a write, so
 *     it is recorded and NOT charged.
 * pi-ai maps `input_tokens_details.cached_tokens` to `cacheRead`
 * (`openai-responses-shared.js:417-425`), so the floor is measurable. Frozen
 * screen rows show cacheRead 0 on ~800-token prefixes because that is below
 * OpenAI's caching minimum, not because it is unreported.
 */

import { MAIN_ENUM } from "./enumerate-variants.mjs";
import { armHandoff } from "./arm-registry.mjs";

/** Provider of a trajectory config. */
export function providerOf(spec) {
	return spec.provider === "openai-codex" ? "openai-codex" : "anthropic";
}

export function isCodex(spec) {
	return providerOf(spec) === "openai-codex";
}

/**
 * The two edits that turn MAIN into ENUM, applied to whichever rendering of
 * MAIN the provider uses. ENUM is not a registry arm — it is MAIN's contract
 * with a findings-LIST grammar — so its OpenAI form is built the same way its
 * Anthropic form was: by editing MAIN's text, not by re-authoring it.
 */
const ENUM_GRAMMAR_FROM = '{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';
const ENUM_GRAMMAR_TO = '{"findings":[{"action":"print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}';
const ENUM_ROUTING_FROM = "Noop unless something warrants feedback.";
const ENUM_ROUTING_TO =
	"List every finding the lens surfaces, each as its own entry with its own action; empty findings array if none. Do not rank them or pick one.";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

export function enumEnvelopeFrom(mainEnvelope) {
	return replaceOnce(
		replaceOnce(mainEnvelope, ENUM_GRAMMAR_FROM, ENUM_GRAMMAR_TO, "enum-openai/grammar"),
		ENUM_ROUTING_FROM,
		ENUM_ROUTING_TO,
		"enum-openai/routing",
	);
}

/**
 * The handoff for one arm on one provider.
 *
 * Anthropic: one combined user prompt, no envelope — exactly what ARM_PROMPTS
 * already holds, so the Anthropic path is unchanged byte-for-byte.
 * OpenAI: raw lens as the prompt, contract as the developer envelope.
 *
 * The registry renders the OpenAI split for its own arms; ENUM is derived from
 * MAIN's OpenAI envelope by the same two edits that define it on Anthropic, so
 * a trajectory row and a probe row carry the same contract on both providers.
 */
export function handoffFor(arm, spec, { head, lens, anthropicPrompt }) {
	if (!isCodex(spec)) {
		return { prompt: anthropicPrompt, envelope: undefined };
	}
	if (arm === "ENUM") {
		const main = armHandoff("screen-a0", "openai-codex", { head, lens });
		return { prompt: main.prompt, envelope: enumEnvelopeFrom(main.envelope) };
	}
	const registryArm = arm === "MAIN" ? "screen-a0" : arm === "F" ? "screen-footer" : arm;
	const handoff = armHandoff(registryArm, "openai-codex", { head, lens });
	return { prompt: handoff.prompt, envelope: handoff.envelope };
}

/**
 * Live assertions for an OpenAI observation row.
 *
 * The cache-read floor is the one that carries the cost claim, and it ports
 * unchanged. What is deliberately NOT asserted, with the reason:
 *   - piggyback `cacheWrite === 0`: OpenAI reports `cache_write_tokens` but
 *     does not bill a write and gives no control over when one happens.
 *   - the run-end writer/reader M-delta: there are no explicit markers, so the
 *     asymmetry the Anthropic composition corrects for does not arise.
 * Both are RECORDED on the row so a later analysis can revisit them.
 */
export function checkOpenAIObservationRow(row, { driverPayloadHash, cacheFloor = OPENAI_CACHE_FLOOR }) {
	const failures = [];
	if (row.capturedPayloadHash !== driverPayloadHash) {
		failures.push(`payload hash ${row.capturedPayloadHash} != driver ${driverPayloadHash}`);
	}
	// Below OpenAI's caching minimum no cache exists to ride, so the floor is
	// not applicable rather than violated — asserting it would fail every early
	// point of every trajectory for a reason that is not a defect.
	if (row.prefixTokens >= OPENAI_MIN_CACHEABLE_PREFIX && row.cacheRead < cacheFloor * row.prefixTokens) {
		failures.push(
			`cacheRead ${row.cacheRead} below ${cacheFloor} x prefix ${row.prefixTokens} — the observation is not riding the driver's cache`,
		);
	}
	return failures;
}

/** OpenAI does not cache prefixes below this; documented threshold. */
export const OPENAI_MIN_CACHEABLE_PREFIX = 1024;

/**
 * The OpenAI cache floor, and why it is not Anthropic's 0.95.
 *
 * MEASURED FIRST, then chosen — a smoke trajectory (sol-high, 8 points) gave
 * cacheRead = 1536, 10752, 11776, 14848 against prefixes 1760, 11311, 12849,
 * 14974: hit ratios 87.3%, 95.1%, 91.6%, 99.2%. Every one of those cacheRead
 * values is an EXACT MULTIPLE OF 128, which is OpenAI's prefix-cache block
 * size. The uncached remainder is the driver's newest turn, which has not
 * entered the cache when the observation fires immediately after.
 *
 * Anthropic can hold 0.95 because `cache_control` caches to an exact marker.
 * OpenAI cannot: the cached span is the longest matching prefix rounded DOWN
 * to a block boundary, minus whatever the driver just added. Keeping 0.95
 * would fail healthy rows for a reason that is not a defect.
 *
 * 0.80 still catches what the assertion exists to catch — an observation
 * paying FULL price for the prefix, which is the failure that would make every
 * cost figure meaningless (that shows up as cacheRead 0, not 0.9). The ratio is
 * recorded on every row, so a slow degradation stays visible in analysis rather
 * than hiding behind a passing gate.
 */
export const OPENAI_CACHE_FLOOR = 0.8;

/**
 * OpenAI cost for one observation. No marker mechanics, so no writer/reader
 * correction: the raw price IS production's single-head price. `cacheWrite` is
 * reported by pi-ai but not billed by OpenAI, so it is excluded from the charge
 * and kept on the row.
 */
export function composeOpenAIObservationCost(usage, prices, extraUsage = null) {
	const one = (u) => (u.cacheRead * prices.cacheRead + u.input * prices.input + u.output * prices.output) / 1e6;
	return one(usage) + (extraUsage ? one(extraUsage) : 0);
}
