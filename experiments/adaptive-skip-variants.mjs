#!/usr/bin/env node
/**
 * Q2 bisection variants (`ADAPTIVE-SKIP-SPEC.md`): MAIN's rendered contract with
 * exactly ONE feature taken from F2, so a skip-rate move is attributable to that
 * feature. Emitted as a plain `{variantId: promptString}` JSON map for
 * `adaptive-skip-probe.mjs` — deliberately NOT registry arms: these are throwaway
 * diagnostics, and putting them in the registry would drag six dead contracts
 * through every invariant suite afterwards.
 *
 * Every variant is derived by string surgery on the rendered MAIN prompt and
 * asserts its own edit landed, so a builder change upstream breaks this loudly
 * instead of silently producing MAIN six times.
 *
 * Usage: node experiments/adaptive-skip-variants.mjs > variants.json
 */

import { GOLDEN_HEADS } from "./delivery-context-golden-cases.mjs";
import {
	buildFramedFooterObservationPrompt,
	buildShippedMainObservationPrompt,
} from "./delivery-context-evaluation.mjs";

export const HEAD = "quality";
export const LENS = GOLDEN_HEADS[HEAD];

export const MAIN = buildShippedMainObservationPrompt(HEAD, LENS);
export const F2 = buildFramedFooterObservationPrompt(HEAD, LENS);

// --- the units, lifted verbatim from the two rendered prompts ------------------

/** MAIN's grammar: a JSON object whose schema carries both character caps. */
export const MAIN_GRAMMAR =
	'Reply with one JSON object, nothing else:\n{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';

/** MAIN's routing: five declarative sentences, no conditions, no precedence. */
export const MAIN_ROUTING =
	"Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line.";

/** F2's routing: the ordered first-match checklist plus the selection clause. */
export const F2_ROUTING =
	"Take the first rule that fits and stop. When the agent can act now to stop harm already in progress, that sets the delivery.\n1. An emergency that must abort the run: interrupt.\n2. Already delivered: none. Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved. It is live again if the agent refuses it or the situation changes. The agent naming a problem, or saying only someone else can resolve it, neither delivers nor resolves it.\n3. Work currently underway that the agent itself must carry out would be left incorrect, unsafe, incomplete, or unverified: steer. That it could be addressed on a later turn does not make it queue.\n4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.\n5. Genuinely deferrable follow-up: queue.\n6. Otherwise: none.\nWhat the agent may or can do decides the route, not the finding: report the most consequential problem the lens finds, not the most actionable one.";

/** F2's footer grammar. */
export const F2_GRAMMAR =
	"If nothing warrants feedback, reply with exactly DELIVERY: none and nothing else. Otherwise write one concise lens finding as natural text, at most 240 characters, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt.";

/** F2's evidence discipline, the first sentence only (spec Q2b). */
export const F2_DISCIPLINE = "Every claim must be supported by the visible trajectory.";

/** F2's tool denial. */
export const F2_TOOL_DENIAL =
	"You have no tools: any tools you can see belong to the cached driver request and are unavailable here.";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found in MAIN — a builder changed upstream`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

/**
 * a. ROUTING — MAIN's five routing sentences replaced by F2's checklist.
 *    Substitution, not addition: keeping both would state two contradictory
 *    routing schemes and stop being one feature.
 */
export const V_ROUTING = replaceOnce(MAIN, MAIN_ROUTING, F2_ROUTING, "a/routing");

/** b. DISCIPLINE — MAIN + F2's evidence sentence. Pure addition; MAIN has none. */
export const V_DISCIPLINE = replaceOnce(
	MAIN,
	'No tools, no "let me check...", no follow-up turn.',
	`No tools, no "let me check...", no follow-up turn. ${F2_DISCIPLINE}`,
	"b/discipline",
);

/** c. TOOL-DENIAL — MAIN + F2's long tool-denial sentence. Pure addition. */
export const V_TOOLDENIAL = replaceOnce(
	MAIN,
	'No tools, no "let me check...", no follow-up turn.',
	`${F2_TOOL_DENIAL} No tools, no "let me check...", no follow-up turn.`,
	"c/tooldenial",
);

/** d. GRAMMAR — MAIN's JSON grammar replaced by F2's footer grammar. */
export const V_GRAMMAR = replaceOnce(MAIN, MAIN_GRAMMAR, F2_GRAMMAR, "d/grammar");

/**
 * e. CAPPROSE — the same caps, expressed F2's way. The JSON schema's inline
 *    annotations move out into a prose sentence, so cap PRESENCE is held
 *    constant and only its expression changes. Pairs with (f), which removes
 *    the cap instead of moving it.
 */
export const V_CAPPROSE = replaceOnce(
	replaceOnce(
		MAIN,
		'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
		'{"action":"noop|print|queue|steer|interrupt","reason":"...","message":"... empty if noop"}',
		"e/capprose-schema",
	),
	'No tools, no "let me check...", no follow-up turn.',
	'Keep reason to at most 120 characters and message to at most 240 characters. No tools, no "let me check...", no follow-up turn.',
	"e/capprose-prose",
);

/** f. NOCAPS — MAIN with both character caps gone and not restated anywhere. */
export const V_NOCAPS = replaceOnce(
	MAIN,
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}',
	'{"action":"noop|print|queue|steer|interrupt","reason":"...","message":"... empty if noop"}',
	"f/nocaps",
);

export const VARIANTS = {
	MAIN,
	F2,
	"a-routing": V_ROUTING,
	"b-discipline": V_DISCIPLINE,
	"c-tooldenial": V_TOOLDENIAL,
	"d-grammar": V_GRAMMAR,
	"e-capprose": V_CAPPROSE,
	"f-nocaps": V_NOCAPS,
};

// Each variant must differ from MAIN (except MAIN) and from every other one:
// a silent no-op edit would read as "this feature does nothing".
for (const [id, text] of Object.entries(VARIANTS)) {
	if (id !== "MAIN" && text === MAIN) throw new Error(`variant ${id} is byte-identical to MAIN`);
}
if (new Set(Object.values(VARIANTS)).size !== Object.keys(VARIANTS).length) {
	throw new Error("two variants render identically");
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.stdout.write(`${JSON.stringify(VARIANTS, null, 2)}\n`);
	process.stderr.write("variant".padEnd(16) + "chars  delta vs MAIN\n");
	for (const [id, text] of Object.entries(VARIANTS)) {
		process.stderr.write(`${id.padEnd(16)}${String(text.length).padEnd(7)}${text.length - MAIN.length >= 0 ? "+" : ""}${text.length - MAIN.length}\n`);
	}
}
