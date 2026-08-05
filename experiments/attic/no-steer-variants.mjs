#!/usr/bin/env node
/**
 * No-steer variants (`NO-STEER-SPEC.md`): MAIN and F2 with `steer` removed from
 * the model's vocabulary, so everything the agent must act on routes as `queue`
 * and the RUNTIME would promote it. The point is causal: the skip study found
 * steer and thinking perfectly coupled but could not say which way the arrow
 * runs. Deleting the label is the manipulation that separates "choosing steer
 * triggers deliberation" from "a serious situation triggers both".
 *
 * Same throwaway-diagnostic pattern as `adaptive-skip-variants.mjs`: plain
 * `{variantId: promptString}` for `adaptive-skip-probe.mjs`, NOT registry arms —
 * these contracts exist to be measured once and discarded, and registering them
 * would drag two dead contracts through every invariant suite afterwards.
 *
 * Each edit is byte-precise string surgery on the rendered parent and asserts
 * that its anchor was found, so an upstream builder change breaks this loudly
 * instead of silently producing the parent twice.
 *
 * DESIGN NOTE, so the manipulation is not confounded. Deleting steer's sentence
 * alone would leave urgent findings with nowhere to go — MAIN's remaining queue
 * reads "useful but waitable", F2's rule 5 reads "genuinely deferrable" — and
 * the model would have to spill them into print, interrupt or silence. That
 * would be REMOVING A CAPABILITY, a different experiment. So in both variants
 * queue ABSORBS steer's semantics: one agent-directed non-emergency channel
 * covering urgent and deferrable alike. `interrupt` stays in both (spec).
 *
 * Usage: node experiments/no-steer-variants.mjs > variants.json
 */

import { MAIN, F2 } from "../adaptive-skip-variants.mjs";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

// --- MAIN-NS ------------------------------------------------------------------
// Two edits: the enum drops `steer`, and the two agent-directed routing
// sentences collapse into one queue sentence that covers both urgencies.

export const MAIN_NS = replaceOnce(
	replaceOnce(
		MAIN,
		'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		'{"action":"noop|print|queue|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		"main-ns/enum",
	),
	"Queue if useful but waitable. Steer to correct the agent between turns.",
	"Queue anything the agent should act on, whether it can wait or not.",
	"main-ns/routing",
);

// --- F2-NS --------------------------------------------------------------------
// Three edits: the grammar's delivery list drops `steer`; rules 3 and 5 merge
// into one queue rule carrying both clauses; the trailing rules renumber.

export const F2_NS = replaceOnce(
	replaceOnce(
		F2,
		"write DELIVERY: followed by print, queue, steer, or interrupt.",
		"write DELIVERY: followed by print, queue, or interrupt.",
		"f2-ns/grammar",
	),
	`3. Work currently underway that the agent itself must carry out would be left incorrect, unsafe, incomplete, or unverified: steer. That it could be addressed on a later turn does not make it queue.
4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.
5. Genuinely deferrable follow-up: queue.
6. Otherwise: none.`,
	`3. Anything the agent itself must carry out: queue. This covers both work currently underway that would be left incorrect, unsafe, incomplete, or unverified, and genuinely deferrable follow-up.
4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.
5. Otherwise: none.`,
	"f2-ns/rules",
);

export const VARIANTS = { "MAIN-NS": MAIN_NS, "F2-NS": F2_NS };

// The word must be gone from the model's view, not merely de-emphasised: a
// surviving "steer" anywhere would leave the label available and void the test.
for (const [id, text] of Object.entries(VARIANTS)) {
	if (/steer/i.test(text)) throw new Error(`${id}: the word "steer" survives the edit`);
	if (!/interrupt/.test(text)) throw new Error(`${id}: interrupt was removed — that is a different experiment`);
	if (!/queue/.test(text)) throw new Error(`${id}: queue is missing`);
}
if (MAIN_NS === MAIN || F2_NS === F2) throw new Error("a no-steer variant is byte-identical to its parent");

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(`${JSON.stringify(VARIANTS, null, 2)}\n`);
	process.stderr.write(`MAIN-NS ${MAIN_NS.length} chars (${MAIN_NS.length - MAIN.length} vs MAIN ${MAIN.length})\n`);
	process.stderr.write(`F2-NS   ${F2_NS.length} chars (${F2_NS.length - F2.length} vs F2 ${F2.length})\n`);
}
