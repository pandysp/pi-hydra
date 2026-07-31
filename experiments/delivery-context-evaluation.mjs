export const DRIVER_INVISIBLE = "driver-invisible";
export const DRIVER_AWARE = "driver-aware";

export const GOLDEN_ARM_IMPLEMENTATIONS = Object.freeze({
	A: "main-json",
	B: "control",
	C: "samehead",
	A0: "screen-a0",
	J: "screen-json",
	F: "screen-footer",
});

/**
 * The unified-API screen arms. Their prompt contracts, tool surface, and
 * parser share this module rather than the runner so the invariant test can
 * import them: the runner is a script that parses argv and runs the matrix on
 * import, and the byte-equality assertions must hold before any provider spend.
 */
export const SCREEN_ARMS = Object.freeze(new Set(["screen-a0", "screen-json", "screen-footer"]));

export function implementationArm(arm) {
	return GOLDEN_ARM_IMPLEMENTATIONS[arm] ?? arm;
}

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

const SCREEN_ROUTING = `Route by who must act and when. ${SCREEN_STEER_CLAUSE} ${SCREEN_DEDUP_CLAUSE}`;

/** J: A's three-field shape and vocabulary verbatim, no rename. */
export const SCREEN_JSON_GRAMMAR = `Reply with one JSON object, nothing else:
${SHIPPED_MAIN_DECISION_SHAPE}
Use action "noop" when nothing warrants feedback; otherwise message carries the finding.`;

/** F: the natural finding plus the DELIVERY footer, numeric bound restored. */
export const SCREEN_FOOTER_GRAMMAR =
	"If nothing warrants feedback, reply with exactly DELIVERY: none and nothing else. Otherwise write one concise lens finding as natural text, at most 240 characters, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt.";

/** The provider-invariant part of the unified envelope. */
export function screenProtocolBlock(head, grammar) {
	return [
		SCREEN_TOOL_DENIAL,
		SCREEN_COMPLETION_CARDINALITY,
		grammar,
		SCREEN_ROUTING,
		`Every claim must be supported by the visible trajectory. Keep any finding to at most two sentences and never prefix it with [${head}].`,
	].join("\n\n");
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

const DRIVER_TOOL_STUBS = [
	{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
	{ name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
	{ name: "edit", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"] } },
	{ name: "write", description: "Write a file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
];

// Management-only public schema: a tool-free completion contract must not make
// every driver request pay for a completion action it never calls.
const MANAGEMENT_ONLY_HYDRA_TOOL = {
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
export function visibleDriverTools(provider, arm, serializedObservationTools) {
	const stubs = DRIVER_TOOL_STUBS.map((tool) => serializeTool(provider, tool));
	return SCREEN_ARMS.has(arm)
		? [...stubs, serializeTool(provider, MANAGEMENT_ONLY_HYDRA_TOOL)]
		: [...stubs, ...(serializedObservationTools ?? [])];
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

export function sameDeliveryBucket(actual, expected) {
	return deliveryBucket(actual) === deliveryBucket(expected);
}

export function isDeliveryBucketCorrect(actual, expected) {
	return typeof actual === "string" && sameDeliveryBucket(actual, expected);
}

// TODO: Revisit whether interrupt needs its own bucket and urgency-specific
// gates once the corpus has enough emergency and near-emergency observations.
