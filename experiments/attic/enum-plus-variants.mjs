#!/usr/bin/env node
/**
 * ENUM+ variants (`ENUM-PLUS-SPEC.md`): does the support clause CLEAN
 * enumeration, or SUPPRESS it?
 *
 * The design isolates two levers that the measured arms confound. MAIN
 * enumerates (3.30 claims/message) and carries NO support clause — it produced
 * 5 both-judges-not-real claims. F2 carries the clause verbatim ("Every claim
 * must be supported by the visible trajectory.") and caps itself at ONE finding
 * per observation — 2.33 claims/message, 1 not-real claim. So recall and
 * precision are each attributable to a different sentence, but never yet varied
 * independently.
 *
 * ENUM   = MAIN-ENUM: enumeration WITHOUT the support clause.
 * ENUM+D = ENUM plus the support clause, verbatim, and nothing else.
 *
 * ENUM - MAIN   isolates ENUMERATION.
 * ENUM+D - ENUM isolates the SUPPORT CLAUSE. That is the decisive contrast:
 * if the clause halves not-real claims while holding claims/message, the levers
 * are separable; if it collapses claims/message instead, the tradeoff is real.
 *
 * MAIN-ENUM is the ENUM base rather than F2-ENUM precisely BECAUSE MAIN lacks
 * the clause — F2-ENUM already carries it, so it cannot serve as the
 * clause-absent control.
 *
 * Throwaway-diagnostic pattern, as `no-steer-variants.mjs` and
 * `enumerate-variants.mjs`: plain `{variantId: promptString}` for
 * `adaptive-skip-probe.mjs`, NOT registry arms.
 *
 * Usage: node experiments/enum-plus-variants.mjs > variants.json
 */

import { MAIN, F2 } from "../adaptive-skip-variants.mjs";
import { MAIN_ENUM } from "../enumerate-variants.mjs";

/** F2's discipline sentence, lifted verbatim so the manipulation is one clause. */
export const SUPPORT_CLAUSE = "Every claim must be supported by the visible trajectory.";

if (!F2.includes(SUPPORT_CLAUSE)) throw new Error("the support clause is not in F2 verbatim — a builder changed upstream");
if (MAIN.includes(SUPPORT_CLAUSE)) throw new Error("MAIN already carries the support clause — the contrast is void");
if (MAIN_ENUM.includes(SUPPORT_CLAUSE)) throw new Error("MAIN-ENUM already carries the support clause — the contrast is void");

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

/**
 * One edit, one sentence inserted. It sits immediately before the trailing
 * prefix ban so it lands in the same discipline position F2 uses (F2 orders
 * them: support clause, then length bound, then prefix ban).
 */
export const ENUM_PLUS_D = replaceOnce(
	MAIN_ENUM,
	`No tools, no "let me check...", no follow-up turn. Don't prefix message with [quality].`,
	`No tools, no "let me check...", no follow-up turn. ${SUPPORT_CLAUSE} Don't prefix message with [quality].`,
	"enum+d/support",
);

export const VARIANTS = { MAIN, F2, ENUM: MAIN_ENUM, "ENUM+D": ENUM_PLUS_D };

// The manipulation must be exactly one sentence, and nothing else may move.
if (ENUM_PLUS_D === MAIN_ENUM) throw new Error("ENUM+D is byte-identical to ENUM");
if (!ENUM_PLUS_D.includes(SUPPORT_CLAUSE)) throw new Error("ENUM+D lost the support clause");
if (ENUM_PLUS_D.length - MAIN_ENUM.length !== SUPPORT_CLAUSE.length + 1) {
	throw new Error(`ENUM+D differs from ENUM by ${ENUM_PLUS_D.length - MAIN_ENUM.length} chars, expected ${SUPPORT_CLAUSE.length + 1}`);
}
if (ENUM_PLUS_D.replace(` ${SUPPORT_CLAUSE}`, "") !== MAIN_ENUM) throw new Error("ENUM+D differs from ENUM by more than the clause");
// The enumeration instructions must survive the edit: otherwise the arm tests
// the clause AND a lost list shape.
if (!/findings/.test(ENUM_PLUS_D)) throw new Error("ENUM+D lost the list shape");
if (!/Do not rank them or pick one/.test(ENUM_PLUS_D)) throw new Error("ENUM+D lost the no-selection instruction");
if (!/≤240 chars/.test(ENUM_PLUS_D) || !/≤120 chars/.test(ENUM_PLUS_D)) throw new Error("ENUM+D lost a per-finding cap");

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(`${JSON.stringify(VARIANTS, null, 2)}\n`);
	for (const [id, text] of Object.entries(VARIANTS)) {
		process.stderr.write(`${id.padEnd(7)} ${String(text.length).padStart(5)} chars\n`);
	}
	process.stderr.write(`ENUM+D - ENUM = +${ENUM_PLUS_D.length - MAIN_ENUM.length} chars (the clause, verbatim)\n`);
}
