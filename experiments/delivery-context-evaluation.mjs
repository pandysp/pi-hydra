export const DRIVER_INVISIBLE = "driver-invisible";
export const DRIVER_AWARE = "driver-aware";

/**
 * The unified-API screen arms. Their prompt contracts, tool surface, and
 * parser share this module rather than the runner so the invariant test can
 * import them: the runner is a script that parses argv and runs the matrix on
 * import, and the byte-equality assertions must hold before any provider spend.
 *
 * Arm identity itself — which letter is which implementation, and which
 * implementation advertises which surface — lives in `arm-registry.mjs`. This
 * set is the independent record of which arms advertise the management-only
 * surface, kept so the invariant check can assert the registry still agrees
 * with it; the live producer path reaches the serializer through the registry's
 * `toolSurface` field.
 *
 * The two envelope-repair arms join it because they ARE screen arms — same
 * channel, same surface, differing from `screen-footer` in instruction text
 * alone. Membership decides a tool surface, never a contract, so adding them
 * cannot change what any frozen row means.
 */
export const SCREEN_ARMS = Object.freeze(
	new Set([
		"screen-a0",
		"screen-json",
		"screen-footer",
		"screen-footer-repaired",
		"screen-footer-framed",
		"screen-footer-decidable",
	]),
);

export function sameHeadDeliveryContext(state, head) {
	return {
		...state,
		pending: state.pending.filter((item) => item.head === head),
	};
}

export const SHIPPED_MAIN_DECISION_SHAPE =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';

const SHIPPED_MAIN_ROUTING =
	'Noop unless something warrants feedback. Print a note the user sees but the agent does not. Queue if useful but waitable. Steer to correct the agent between turns. Interrupt only for emergencies that must stop the line. No tools, no "let me check...", no follow-up turn.';

/** Exact judge-only observation prompt shipped on origin/main at b51c157. */
export function buildShippedMainObservationPrompt(head, instruction) {
	return `<system-reminder>Side watcher. Reply with one JSON object, nothing else:
${SHIPPED_MAIN_DECISION_SHAPE}

LENS: ${instruction}

${SHIPPED_MAIN_ROUTING} Don't prefix message with [${head}].</system-reminder>`;
}

/**
 * A0's split-handoff carrier. The contract text is b51c157's verbatim, with
 * the inline LENS line replaced by a reference to the adjacent user message:
 * the placement residue is held constant across the screen arms, so A0 gains
 * nothing else from the unified arms.
 */
export function buildShippedMainObservationEnvelope(head) {
	return `Side watcher. Reply with one JSON object, nothing else:
${SHIPPED_MAIN_DECISION_SHAPE}

The preceding user message is the complete ${head} lens.

${SHIPPED_MAIN_ROUTING} Don't prefix message with [${head}].`;
}

// The unified envelope: one semantic unit per paragraph, each stated exactly
// once, in the order role/lens authority, tool denial, completion cardinality,
// grammar, routing, discipline. Only the grammar paragraph differs between J
// and F, and only the lens unit differs between the two providers.
const SCREEN_TOOL_DENIAL =
	"You have no tools: any tools you can see belong to the cached driver request and are unavailable here.";

const SCREEN_COMPLETION_CARDINALITY = "Answer in exactly one turn; there is no follow-up turn.";

/** The two clauses the record isolates as causal. Interpolated, never restated. */
export const SCREEN_STEER_CLAUSE =
	"For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; that it could be addressed on a later turn does not make it queue. Use print when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.";

export const SCREEN_DEDUP_CLAUSE =
	"Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved.";

export const SCREEN_ROUTING = `Route by who must act and when. ${SCREEN_STEER_CLAUSE} ${SCREEN_DEDUP_CLAUSE}`;

export function screenDiscipline(head) {
	return `Every claim must be supported by the visible trajectory. Keep any finding to at most two sentences and never prefix it with [${head}].`;
}

/**
 * The repaired envelope (`ENVELOPE-REPAIR-SPEC.md`, arms F1 and F2). Separate
 * exports on purpose: F0 is the measured incumbent and every one of its frozen
 * rows must stay reproducible, so the constants above do not move.
 *
 * What the repair addresses, from the xhigh/high screens: on a finding whose
 * remedy belongs to the USER, the current envelope substitutes the most
 * actionable finding for the most consequential one (8/8 rows, unanimous, both
 * efforts) while MAIN never does. The design panel's measurement located the
 * cause in finding SELECTION, not deduplication: `Route by who must act and
 * when` over a menu framed entirely around what the AGENT does turns
 * actionability into a filter on what gets reported at all. Hence
 * `SCREEN_SELECTION_CLAUSE`, which separates the two decisions, and a print
 * branch with an addressee rather than only an absence of agent work.
 *
 * The dedup sentence keeps F0's first clause byte-identical — it is the causal
 * clause behind the measured abstention win (expected-none handled 1/8 for MAIN
 * against 7-8/8 for the envelope arms) — and appends only a re-liveness rule and
 * the statement that the agent's own remark is not a delivery. Re-liveness is
 * deliberately two conditions, not three: "half-fixed" would contradict "even
 * while the underlying issue remains unresolved" in the same paragraph and would
 * license re-firing on exactly the quiet rows the envelope wins today.
 */
export const REPAIRED_ACT_NOW_CLAUSE =
	"When the agent can act now to stop harm already in progress, that sets the delivery.";

export const REPAIRED_STEER_CLAUSE =
	"For feedback about work currently underway that the agent itself must carry out, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; that it could be addressed on a later turn does not make it queue. Use print when the agent need not act, or when the remedy is not the agent's to carry out because it lacks the ability or the permission; print reaches the user and never the agent, so say what the user must do. Use queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.";

export const REPAIRED_SELECTION_CLAUSE =
	"What the agent may or can do decides the route, not the finding: report the most consequential problem the lens finds, not the most actionable one.";

export const REPAIRED_DEDUP_CLAUSE =
	"Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved; a delivered finding is live again if the agent refuses it or the situation changes. The agent naming a problem, or saying only someone else can resolve it, neither delivers nor resolves it.";

/** F1: the repair as prose, in F0's own register. */
export const REPAIRED_ROUTING = `Route by who must act and when. ${REPAIRED_ACT_NOW_CLAUSE} ${REPAIRED_STEER_CLAUSE} ${REPAIRED_SELECTION_CLAUSE} ${REPAIRED_DEDUP_CLAUSE} Otherwise, none.`;

/**
 * F2: the same semantics as an ordered first-match list. F2 - F1 is framing and
 * nothing else, asserted string by string in `screen-arm-invariants.check.mjs`;
 * the pilot's finding is that MAIN's terse capped contract engages ~zero
 * adaptive thinking on realistic prefixes where the envelope engages 690-1013
 * tokens, so framing is the hypothesised lever and it is measured, not assumed.
 */
export const REPAIRED_CHECKLIST_ROUTING = `Take the first rule that fits and stop. ${REPAIRED_ACT_NOW_CLAUSE}
1. An emergency that must abort the run: interrupt.
2. Already delivered: none. Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved. It is live again if the agent refuses it or the situation changes. The agent naming a problem, or saying only someone else can resolve it, neither delivers nor resolves it.
3. Work currently underway that the agent itself must carry out would be left incorrect, unsafe, incomplete, or unverified: steer. That it could be addressed on a later turn does not make it queue.
4. The agent need not act, or the remedy is not the agent's to carry out because it lacks the ability or the permission: print. Print reaches the user and never the agent, so say what the user must do.
5. Genuinely deferrable follow-up: queue.
6. Otherwise: none.
${REPAIRED_SELECTION_CLAUSE}`;

/**
 * F3: F2's semantics at maximum decidability (`ENVELOPE-REPAIR-SPEC.md`, "Next
 * isolated factor: DECIDABILITY"). The hypothesis under test is that thinking is
 * spent on AMBIGUITY, not on tokens, so F3 is deliberately LONGER than F2 and
 * every judgement F2 leaves to the model is stated instead:
 *
 *  - Selection before routing. F2 lists the rules and appends the selection
 *    clause after them, leaving open whether the rules run per candidate finding
 *    or once on a chosen one. F3 makes it two ordered steps.
 *  - A decidable test per rule, in the form of a condition on what the
 *    trajectory shows, rather than a label ("An emergency": when?).
 *  - Precedence for every pair that can collide: 1 over 2 (an in-progress
 *    emergency already raised), 3 over 4 and 4 over 3 (who owns the remedy —
 *    the substitution defect's own boundary), 4 over 5 (user-owned vs deferrable
 *    agent work). F2 leaves these to first-match alone, which is only implicit
 *    precedence.
 *  - Multiple findings: F2's selection clause implies one; F3 says carry exactly
 *    one forward.
 *  - Underdetermination: F2 leaves "can I tell?" to deliberation. F3 decides
 *    tests on what the trajectory shows and forbids assuming what it does not —
 *    a scoping of the discipline unit's evidence rule onto the tests, chosen
 *    over a "when unsure, stay silent" default because that would flatten
 *    findings, which D2 exists to catch.
 *
 * Test 5's "leaves the current work correct, safe, complete and verified" is
 * test 3's third condition contraposed: same criterion, stated once positively
 * and once negatively so neither rule needs the other read to be decided.
 */
export const REPAIRED_DECIDABLE_ROUTING = `Decide in two steps and do not revisit the first once you have passed it.

STEP 1 — pick the finding. Take what the lens finds in the visible trajectory. If it finds nothing, the delivery is none and step 2 does not run. If it finds more than one problem, carry exactly one forward: the most consequential. ${REPAIRED_SELECTION_CLAUSE}

STEP 2 — route that one finding. Read tests 1 to 6 in order, take the first that is true, and stop; a later test never overrides an earlier one. Decide each test on what the trajectory shows and do not assume what it does not show.
1. interrupt — true when harm is happening now and aborting the run is what stops it: an emergency that must abort the run. ${REPAIRED_ACT_NOW_CLAUSE} Test 1 outranks every later test, including test 2.
2. none — true when this same problem was already routed to the agent, in any wording. Semantically equivalent feedback counts as already delivered even while the underlying issue remains unresolved. It is live again if the agent refuses it or the situation changes, and then this test is false. The agent naming a problem, or saying only someone else can resolve it, neither delivers nor resolves it, so neither makes this test true.
3. steer — true when all three hold: the finding is about work currently underway, the agent itself must carry out the remedy, and leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified. That it could be addressed on a later turn does not make it queue. When the agent cannot or may not carry out the remedy, test 3 is false however urgent the finding is: go to test 4.
4. print — true when the agent need not act, or when the remedy is not the agent's to carry out because it lacks the ability or the permission. Print reaches the user and never the agent, so say what the user must do. Tests 3 and 4 collide only over who must act: test 3 when the remedy is the agent's own, test 4 when it is not.
5. queue — true when the remedy is the agent's own and is genuinely deferrable follow-up, meaning leaving it undone leaves the current work correct, safe, complete and verified. When the required actor is the user, test 5 is false and the route is test 4.
6. Otherwise the route is none.`;

/**
 * The anti-deliberation sentence rides the judge-only cardinality unit, so it
 * cannot reach `SCREEN_ACTING_CARDINALITY`, whose "take as many turns as the
 * lens needs" is the opposite instruction for a head that does work.
 */
export const REPAIRED_COMPLETION_CARDINALITY =
	"Answer in exactly one turn; there is no follow-up turn. Decide from what is visible; do not deliberate.";

/**
 * The preamble's lens-authority sentence, split. F0 tells the observer the lens
 * "alone defines scope, intervention criteria, suppression, and deduplication",
 * which hands the routing rules' authority to the lens and is the rationalization
 * surface the substitution defect used. F1/F2 give the lens scope and the rules
 * everything else.
 */
export const REPAIRED_LENS_AUTHORITY = "The lens defines what to look for; the rules below define what to do with it.";

function repairedProtocolBlock(head, grammar, { routing, cardinality }) {
	return [SCREEN_TOOL_DENIAL, cardinality, grammar, routing, screenDiscipline(head)].join("\n\n");
}

function buildRepairedObservationPrompt(head, instruction, grammar, variant) {
	return `<system-reminder>Side watcher. Review the visible trajectory through the lens below; follow it in full. ${REPAIRED_LENS_AUTHORITY}\n\nLENS: ${instruction}\n\n${repairedProtocolBlock(head, grammar, variant)}</system-reminder>`;
}

function buildRepairedObservationEnvelope(head, grammar, variant) {
	return `Side watcher. The preceding user message is the complete ${head} lens; follow it in full. ${REPAIRED_LENS_AUTHORITY} Review the visible trajectory.\n\n${repairedProtocolBlock(head, grammar, variant)}`;
}

const REPAIR_PROSE = Object.freeze({ routing: REPAIRED_ROUTING, cardinality: SCREEN_COMPLETION_CARDINALITY });

const REPAIR_CHECKLIST = Object.freeze({
	routing: REPAIRED_CHECKLIST_ROUTING,
	cardinality: REPAIRED_COMPLETION_CARDINALITY,
});

// F3 keeps F2's cardinality unit verbatim: varying the anti-deliberation
// sentence too would make F3 - F2 two factors instead of decidability alone.
const REPAIR_DECIDABLE = Object.freeze({
	routing: REPAIRED_DECIDABLE_ROUTING,
	cardinality: REPAIRED_COMPLETION_CARDINALITY,
});

export function buildRepairedFooterObservationPrompt(head, instruction) {
	return buildRepairedObservationPrompt(head, instruction, SCREEN_FOOTER_GRAMMAR, REPAIR_PROSE);
}

export function buildRepairedFooterObservationEnvelope(head) {
	return buildRepairedObservationEnvelope(head, SCREEN_FOOTER_GRAMMAR, REPAIR_PROSE);
}

export function buildFramedFooterObservationPrompt(head, instruction) {
	return buildRepairedObservationPrompt(head, instruction, SCREEN_FOOTER_GRAMMAR, REPAIR_CHECKLIST);
}

export function buildFramedFooterObservationEnvelope(head) {
	return buildRepairedObservationEnvelope(head, SCREEN_FOOTER_GRAMMAR, REPAIR_CHECKLIST);
}

export function buildDecidableFooterObservationPrompt(head, instruction) {
	return buildRepairedObservationPrompt(head, instruction, SCREEN_FOOTER_GRAMMAR, REPAIR_DECIDABLE);
}

export function buildDecidableFooterObservationEnvelope(head) {
	return buildRepairedObservationEnvelope(head, SCREEN_FOOTER_GRAMMAR, REPAIR_DECIDABLE);
}

/** J: A's three-field shape and vocabulary verbatim, no rename. */
export const SCREEN_JSON_GRAMMAR = `Reply with one JSON object, nothing else:
${SHIPPED_MAIN_DECISION_SHAPE}
Use action "noop" when nothing warrants feedback; otherwise message carries the finding.`;

/** F: the natural finding plus the DELIVERY footer, numeric bound restored. */
export const SCREEN_FOOTER_GRAMMAR =
	"If nothing warrants feedback, reply with exactly DELIVERY: none and nothing else. Otherwise write one concise lens finding as natural text, at most 240 characters, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt.";

/** The provider-invariant part of the unified envelope. */
export function screenProtocolBlock(head, grammar) {
	return [SCREEN_TOOL_DENIAL, SCREEN_COMPLETION_CARDINALITY, grammar, SCREEN_ROUTING, screenDiscipline(head)].join("\n\n");
}

function buildScreenObservationEnvelope(head, grammar) {
	return `Side watcher. The preceding user message is the complete ${head} lens; follow it in full. The lens alone defines scope, intervention criteria, suppression, and deduplication. Review the visible trajectory.\n\n${screenProtocolBlock(head, grammar)}`;
}

function buildScreenObservationPrompt(head, instruction, grammar) {
	return `<system-reminder>Side watcher. Review the visible trajectory through the lens below; follow it in full. The lens alone defines scope, intervention criteria, suppression, and deduplication.\n\nLENS: ${instruction}\n\n${screenProtocolBlock(head, grammar)}</system-reminder>`;
}

export function buildScreenJsonObservationEnvelope(head) {
	return buildScreenObservationEnvelope(head, SCREEN_JSON_GRAMMAR);
}

export function buildScreenJsonObservationPrompt(head, instruction) {
	return buildScreenObservationPrompt(head, instruction, SCREEN_JSON_GRAMMAR);
}

export function buildScreenFooterObservationEnvelope(head) {
	return buildScreenObservationEnvelope(head, SCREEN_FOOTER_GRAMMAR);
}

export function buildScreenFooterObservationPrompt(head, instruction) {
	return buildScreenObservationPrompt(head, instruction, SCREEN_FOOTER_GRAMMAR);
}

/**
 * The acting half of the same envelope. Only the first two units change: an
 * acting head has tools, so the denial is false, and it works across turns, so
 * "exactly one turn" is false too — `wave2-simplicity §4` scopes the head kind
 * to a paragraph, not a contract. Routing and discipline stay byte-identical
 * to the judge surface, which is the unification claim the invariant check
 * asserts; the completion grammar is the arm.
 */
export const SCREEN_ACTING_CARDINALITY =
	"Take as many turns as the lens needs to do the work, then complete the observation exactly once. Removing your own head successfully completes it; do not complete again afterward.";

/**
 * Head management is named by capability, never by schema key: the wide and
 * management-only schemas spell the operation differently and the tool
 * description already carries that difference, so this paragraph stays
 * byte-identical across the three channel arms.
 */
function screenActingToolStatus(tools, activeHeads, afterChange) {
	const snapshot =
		tools.includes("hydra") && activeHeads !== undefined
			? ` Hydra snapshot at observation start: active heads are ${activeHeads.join(", ") || "none"}; later hydra tool results supersede this snapshot.`
			: "";
	const postChange =
		afterChange === "print"
			? ' After a successful write or edit, deliver "print" with a note describing it; the runtime enforces this.'
			: afterChange === "noop"
				? ' After a successful write or edit, deliver "none" with an empty message because the changed file is the work product; the runtime enforces this.'
				: "";
	return `You may use only these tools: ${tools.join(", ")} to check facts or act on your lens; the main agent does not see your tool calls, only files you change and feedback you route. Head management is available only when hydra is among your allowed work tools, and a successful change prints its own receipt automatically; do not repeat it.${snapshot}${postChange}`;
}

export function screenActingProtocolBlock(head, grammar, options) {
	return [
		screenActingToolStatus(options.tools, options.activeHeads, options.afterChange),
		SCREEN_ACTING_CARDINALITY,
		grammar,
		SCREEN_ROUTING,
		screenDiscipline(head),
	].join("\n\n");
}

export function buildScreenActingObservationPrompt(head, instruction, grammar, options) {
	return `<system-reminder>Side watcher with tool access. Review the visible trajectory through the lens below; follow it in full. The lens alone defines scope, intervention criteria, suppression, and deduplication.\n\nLENS: ${instruction}\n\n${screenActingProtocolBlock(head, grammar, options)}</system-reminder>`;
}

export function buildScreenActingObservationEnvelope(head, grammar, options) {
	return `Side watcher with tool access. The preceding user message is the complete ${head} lens; follow it in full. The lens alone defines scope, intervention criteria, suppression, and deduplication. Review the visible trajectory.\n\n${screenActingProtocolBlock(head, grammar, options)}`;
}

const DRIVER_TOOL_STUBS = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	{ name: "edit", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
	{ name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

// Management-only public schema: a tool-free completion contract must not make
// every driver request pay for a completion action it never calls.
export const MANAGEMENT_ONLY_HYDRA_TOOL = {
	name: "hydra",
	description:
		"Add or remove one active head idempotently. operation is add or remove, head is the head name, and message explains why the change fits the trajectory. A successful observer-originated change automatically prints that explanation.",
	parameters: {
		type: "object",
		properties: {
			operation: { type: "string", enum: ["add", "remove"], description: "Add or remove one active head" },
			head: { type: "string", minLength: 1, description: "The head name" },
			message: { type: "string", maxLength: 1000, description: "Concisely explain the change" },
		},
		required: ["operation", "head", "message"],
		additionalProperties: false,
	},
};

function serializeTool(provider, tool) {
	return provider === "anthropic"
		? { name: tool.name, description: tool.description, input_schema: tool.parameters }
		: { type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false };
}

/**
 * Production-cache fidelity: the merge replays the driver's tools array, so
 * every arm's payload carries representative driver stubs plus the hydra
 * schema the driver advertises. The screen arms replace the wide schema pi-ai
 * serialized for the observation with the management-only one.
 */
export function serializeDriverTools(provider, toolSurface, serializedObservationTools) {
	const stubs = DRIVER_TOOL_STUBS.map((tool) => serializeTool(provider, tool));
	return toolSurface === "management-only"
		? [...stubs, serializeTool(provider, MANAGEMENT_ONLY_HYDRA_TOOL)]
		: [...stubs, ...(serializedObservationTools ?? [])];
}

/** Arm-keyed shim over the frozen `SCREEN_ARMS` record; the registry is the live path. */
export function visibleDriverTools(provider, arm, serializedObservationTools) {
	return serializeDriverTools(provider, SCREEN_ARMS.has(arm) ? "management-only" : "wide", serializedObservationTools);
}

const buckets = new Map([
	["none", DRIVER_INVISIBLE],
	["print", DRIVER_INVISIBLE],
	["queue", DRIVER_AWARE],
	["steer", DRIVER_AWARE],
	["interrupt", DRIVER_AWARE],
]);

export function deliveryBucket(delivery) {
	const bucket = buckets.get(delivery);
	if (!bucket) throw new Error(`unknown delivery: ${delivery}`);
	return bucket;
}

/**
 * The corpus category vocabulary, declared once, with every category assigned a
 * class. The summarizer derives two category metrics — restraint on the
 * waiting families, quality on the follow-up families — and used to spell their
 * membership as two literal string sets. A category in neither vanished from
 * both metrics silently, which is how a freshly authored family would be
 * measured by nothing at all.
 *
 * `unmetered` is the explicit third class: those categories are covered by the
 * corpus-wide metrics and deliberately carry no category-specific one. Anything
 * outside all three is `unclassified`, counted by the summarizer and fatal in
 * gate mode.
 */
export const WAITING_CATEGORIES = Object.freeze([
	"pending-equivalent",
	"newly-delivered-no-response",
	"visible-no-response",
	"full-resolution",
]);

export const FOLLOWUP_CATEGORIES = Object.freeze([
	"explicit-rejection",
	"material-change",
	"older-visible-rejection",
	"partial-resolution",
]);

export const UNMETERED_CATEGORIES = Object.freeze([
	"fresh",
	"pending-unrelated",
	"deferrable-follow-up",
	"user-only",
	"emergency",
]);

export const KNOWN_CATEGORIES = Object.freeze(
	[...WAITING_CATEGORIES, ...FOLLOWUP_CATEGORIES, ...UNMETERED_CATEGORIES].sort(),
);

export function categoryClass(category) {
	if (WAITING_CATEGORIES.includes(category)) return "waiting";
	if (FOLLOWUP_CATEGORIES.includes(category)) return "followup";
	if (UNMETERED_CATEGORIES.includes(category)) return "unmetered";
	return "unclassified";
}

export function sameDeliveryBucket(actual, expected) {
	return deliveryBucket(actual) === deliveryBucket(expected);
}

export function isDeliveryBucketCorrect(actual, expected) {
	return typeof actual === "string" && sameDeliveryBucket(actual, expected);
}

// TODO: Revisit whether interrupt needs its own bucket and urgency-specific
// gates once the corpus has enough emergency and near-emergency observations.
