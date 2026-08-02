#!/usr/bin/env node
/**
 * Steer-only variants (`STEER-ONLY-SPEC.md`): MAIN, F2 and ENUM with `queue`
 * removed from the model's vocabulary, so everything agent-directed routes as
 * `steer` — Andreas's proposed runtime simplification (2026-08-02): "remove
 * queue as label at all from the entire harness. Steer is the new steer +
 * queue."
 *
 * The mirror image of `no-steer-variants.mjs`. That probe deleted STEER and
 * let queue absorb it, measuring the label's cost; this one deletes QUEUE and
 * lets steer absorb it, measuring what the simplified vocabulary does to the
 * thinking shapes the cost story rests on (steer rows think ~1000 tokens,
 * queue rows think ~0, ENUM thinks 0 everywhere on opus).
 *
 * Same throwaway-diagnostic pattern as the prior probes: plain
 * `{variantId: promptString}` for `adaptive-skip-probe.mjs`, NOT registry arms.
 * Each edit is byte-precise string surgery on the rendered parent and asserts
 * its anchor was found, so an upstream builder change breaks loudly.
 *
 * DESIGN NOTE, the same one no-steer needed, mirrored. Deleting queue's
 * sentence alone would leave deferrable findings with nowhere to go — MAIN's
 * remaining steer reads "correct the agent between turns", F2's rule 3 reads
 * "work currently underway" — and the model would have to spill them into
 * print or silence. That would be REMOVING A CAPABILITY, a different
 * experiment. So in all three variants steer ABSORBS queue's semantics: one
 * agent-directed channel covering urgent and deferrable alike, which is
 * exactly the proposed runtime shape. `interrupt` stays.
 *
 * Usage: node experiments/steer-only-variants.mjs > variants.json
 */

import { MAIN, F2 } from "./adaptive-skip-variants.mjs";
import { MAIN_ENUM } from "./enumerate-variants.mjs";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

// --- MAIN-SO --------------------------------------------------------------------
// Two edits: the enum drops `queue`, and the two agent-directed routing
// sentences collapse into one steer sentence covering both urgencies — the
// byte-level mirror of MAIN-NS's queue-absorbs-steer collapse.

export const MAIN_SO = replaceOnce(
	replaceOnce(
		MAIN,
		'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		'{"action":"noop|print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		"main-so/enum",
	),
	"Queue if useful but waitable. Steer to correct the agent between turns.",
	"Steer anything the agent should act on, whether it can wait or not.",
	"main-so/routing",
);

// --- F2-SO ----------------------------------------------------------------------
// Three edits, mirroring F2-NS: the grammar's delivery list drops `queue`;
// rules 3 and 5 merge into one steer rule carrying both clauses; the trailing
// rules renumber.

export const F2_SO = replaceOnce(
	replaceOnce(
		F2,
		"write DELIVERY: followed by print, queue, steer, or interrupt.",
		"write DELIVERY: followed by print, steer, or interrupt.",
		"f2-so/grammar",
	),
	`3. Work currently underway that the agent itself must carry out would be left incorrect, unsafe, incomplete, or unverified: steer. That it could be addressed on a later turn does not make it queue.
4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.
5. Genuinely deferrable follow-up: queue.
6. Otherwise: none.`,
	`3. Anything the agent itself must carry out: steer. This covers both work currently underway that would be left incorrect, unsafe, incomplete, or unverified, and genuinely deferrable follow-up.
4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.
5. Otherwise: none.`,
	"f2-so/rules",
);

// --- ENUM-SO --------------------------------------------------------------------
// MAIN-ENUM with MAIN-SO's two edits transposed: the per-finding action list
// drops `queue`, and the surviving routing sentences collapse the same way
// (MAIN-ENUM replaced only MAIN's noop sentence, so the queue/steer pair is
// still present verbatim).

export const ENUM_SO = replaceOnce(
	replaceOnce(
		MAIN_ENUM,
		'{"findings":[{"action":"print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}',
		'{"findings":[{"action":"print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}',
		"enum-so/enum",
	),
	"Queue if useful but waitable. Steer to correct the agent between turns.",
	"Steer anything the agent should act on, whether it can wait or not.",
	"enum-so/routing",
);

export const VARIANTS = {
	MAIN,
	"MAIN-SO": MAIN_SO,
	F2,
	"F2-SO": F2_SO,
	ENUM: MAIN_ENUM,
	"ENUM-SO": ENUM_SO,
};

// The word must be gone from the model's view, not merely de-emphasised: a
// surviving "queue" anywhere would leave the label available and void the test.
for (const [id, text] of Object.entries({ "MAIN-SO": MAIN_SO, "F2-SO": F2_SO, "ENUM-SO": ENUM_SO })) {
	if (/queue/i.test(text)) throw new Error(`${id}: the word "queue" survives the edit`);
	if (!/interrupt/.test(text)) throw new Error(`${id}: interrupt was removed — that is a different experiment`);
	if (!/steer/i.test(text)) throw new Error(`${id}: steer is missing`);
}
if (MAIN_SO === MAIN || F2_SO === F2 || ENUM_SO === MAIN_ENUM) {
	throw new Error("a steer-only variant is byte-identical to its parent");
}
if (new Set(Object.values(VARIANTS)).size !== Object.keys(VARIANTS).length) {
	throw new Error("two variants render identically");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(`${JSON.stringify(VARIANTS, null, 2)}\n`);
	process.stderr.write(`MAIN-SO ${MAIN_SO.length} chars (${MAIN_SO.length - MAIN.length} vs MAIN ${MAIN.length})\n`);
	process.stderr.write(`F2-SO   ${F2_SO.length} chars (${F2_SO.length - F2.length} vs F2 ${F2.length})\n`);
	process.stderr.write(`ENUM-SO ${ENUM_SO.length} chars (${ENUM_SO.length - MAIN_ENUM.length} vs ENUM ${MAIN_ENUM.length})\n`);
}
