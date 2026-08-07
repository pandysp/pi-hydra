#!/usr/bin/env node
/**
 * Enumerate-vs-select variants (`ENUMERATE-SPEC.md`): MAIN and F2 with the act
 * of SELECTION removed, so the observer lists every finding it sees and the
 * runtime triages, instead of picking one and justifying the pick.
 *
 * Why this manipulation. no-steer measured MAIN-NS at -77% thinking with
 * coverage UP, and its output shape shifted from "one urgent thing" to "here
 * are the gaps" — which suggests the expensive act is choosing, not finding.
 * It is also the only untested candidate for the ENVELOPE's cost: framing,
 * decidability and label-removal all left F2 unmoved, and F2's ordered
 * first-match rule surface IS a selection procedure. F2-ENUM is therefore the
 * decisive arm.
 *
 * Same throwaway-diagnostic pattern as `no-steer-variants.mjs`: plain
 * `{variantId: promptString}` for `adaptive-skip-probe.mjs`, NOT registry arms.
 *
 * DESIGN NOTE, so the manipulation is not confounded with verbosity. Both
 * variants keep the per-item discipline verbatim — MAIN-ENUM keeps the 120/240
 * character caps per finding, F2-ENUM keeps "at most 240 characters" and "at
 * most two sentences" per finding. Enumeration bounds the LIST, not the ITEM.
 * A variant that also relaxed the per-item cap would be testing two things.
 *
 * DESIGN NOTE on F2-ENUM's third edit. F2's selection clause ("report the most
 * consequential problem the lens finds, not the most actionable one") was added
 * by the envelope repair to stop actionability filtering WHICH finding gets
 * reported. Under enumeration that failure mode dissolves — everything is
 * reported — so the clause becomes a per-finding labelling rule instead. The
 * anti-substitution intent is preserved in the rewrite; only its selecting
 * function is removed. Per the spec this is in scope ("the rules become labels
 * applied to each finding found, not a procedure for choosing one").
 *
 * Usage: node experiments/enumerate-variants.mjs > variants.json
 */

import { MAIN, F2 } from "./adaptive-skip-variants.mjs";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

// --- MAIN-ENUM ----------------------------------------------------------------
// Two edits: the JSON shape carries a LIST of findings instead of one action,
// and the routing preamble asks for all of them rather than implying one.
// The per-finding caps are carried over unchanged.

export const MAIN_ENUM = replaceOnce(
	replaceOnce(
		MAIN,
		'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		'{"findings":[{"action":"print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}',
		"main-enum/grammar",
	),
	"Noop unless something warrants feedback.",
	"List every finding the lens surfaces, each as its own entry with its own action; empty findings array if none. Do not rank them or pick one.",
	"main-enum/routing",
);

// --- F2-ENUM ------------------------------------------------------------------
// Three edits: the grammar emits every finding as its own block; the rule
// preamble labels each finding instead of stopping at the first match; the
// selection clause becomes a per-finding labelling rule.

export const F2_ENUM = replaceOnce(
	replaceOnce(
		replaceOnce(
			F2,
			"Otherwise write one concise lens finding as natural text, at most 240 characters, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt.",
			"Otherwise write every lens finding you see, one block each: the finding as natural text, at most 240 characters, then on its own line DELIVERY: followed by print, queue, steer, or interrupt. Separate blocks with a blank line. Do not rank them or pick one.",
			"f2-enum/grammar",
		),
		"Take the first rule that fits and stop. When the agent can act now to stop harm already in progress, that sets the delivery.",
		"Label each finding with the first rule that fits it. When the agent can act now to stop harm already in progress, that sets that finding's delivery.",
		"f2-enum/preamble",
	),
	"What the agent may or can do decides the route, not the finding: report the most consequential problem the lens finds, not the most actionable one.",
	"What the agent may or can do decides each finding's label, not whether to report it: report every problem the lens finds, not only the most actionable ones.",
	"f2-enum/selection",
);

export const VARIANTS = { MAIN, "MAIN-ENUM": MAIN_ENUM, F2, "F2-ENUM": F2_ENUM };

// The selecting instructions must be gone from the model's view, and the
// per-item discipline must survive: a variant that dropped the caps would be
// testing verbosity as well as enumeration.
if (/first rule that fits and stop/.test(F2_ENUM)) throw new Error("F2-ENUM: the first-match stop survives");
if (/most consequential problem/.test(F2_ENUM)) throw new Error("F2-ENUM: the selection clause survives");
if (!/at most 240 characters/.test(F2_ENUM)) throw new Error("F2-ENUM: the per-finding cap was lost");
if (!/at most two sentences/.test(F2_ENUM)) throw new Error("F2-ENUM: the per-finding sentence bound was lost");
if (!/≤240 chars/.test(MAIN_ENUM)) throw new Error("MAIN-ENUM: the per-finding cap was lost");
if (!/≤120 chars/.test(MAIN_ENUM)) throw new Error("MAIN-ENUM: the reason cap was lost");
if (!/findings/.test(MAIN_ENUM)) throw new Error("MAIN-ENUM: the list shape is missing");
if (MAIN_ENUM === MAIN || F2_ENUM === F2) throw new Error("an enumerate variant is byte-identical to its parent");

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(`${JSON.stringify(VARIANTS, null, 2)}\n`);
	process.stderr.write(`MAIN-ENUM ${MAIN_ENUM.length} chars (${MAIN_ENUM.length - MAIN.length >= 0 ? "+" : ""}${MAIN_ENUM.length - MAIN.length} vs MAIN ${MAIN.length})\n`);
	process.stderr.write(`F2-ENUM   ${F2_ENUM.length} chars (${F2_ENUM.length - F2.length >= 0 ? "+" : ""}${F2_ENUM.length - F2.length} vs F2 ${F2.length})\n`);
}
