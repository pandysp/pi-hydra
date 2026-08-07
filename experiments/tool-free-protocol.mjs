import { StringEnum, Type } from "@earendil-works/pi-ai";
import { decisionFromCompletion, headActs } from "../utils.ts";

export const TOOL_FREE_DECISION_SHAPE =
	'{"delivery":"none|print|queue|steer|interrupt","message":"exactly empty with none; concise otherwise"}';
export const MESSAGE_FIRST_DECISION_SHAPE =
	'{"message":"exactly empty with none; concise otherwise","delivery":"none|print|queue|steer|interrupt"}';
export const ASSESSED_DECISION_SHAPE =
	'{"assessment":"brief non-delivered basis for the decision","delivery":"none|print|queue|steer|interrupt","message":"exactly empty with none; concise otherwise"}';
export const ACTION_DECISION_SHAPE =
	'{"action":"complete_observation","delivery":"none|print|queue|steer|interrupt","message":"exactly empty with none; concise otherwise"}';
export const DELIVERY_ACTION_DECISION_SHAPE =
	'{"action":"noop|print|queue|steer|interrupt","message":"exactly empty with noop; concise otherwise"}';

export const managementOnlyHydraParameters = Type.Object(
	{
		action: StringEnum(["manage_heads"], {
			description: 'Always "manage_heads"; use operation to choose add or remove',
		}),
		operation: StringEnum(["add", "remove"], { description: "Add or remove one head" }),
		head: Type.String({ minLength: 1, description: "The head name" }),
		message: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "Concisely explain why the change fits the trajectory",
		}),
	},
	{ additionalProperties: false },
);

export function managementOnlyHydraDescription(userHeadDir) {
	return [
		"Manage hydra heads. Set `action` to `manage_heads`; set `operation` to",
		"`add` or `remove`. The operation changes one active head idempotently;",
		"its message explains why the change fits the trajectory.",
		"A successful observer-originated change automatically prints that",
		"explanation. Heads are markdown files in",
		`${userHeadDir} (user) and .pi/hydra (project):`,
		"frontmatter `name:` and `description:` are required; `tools:` is omitted",
		"for all tools, `[]` for a judge-only head, or a comma-separated subset;",
		"`autostart: true` joins fresh sessions; heads with write/edit may set",
		"`after-change:` to `noop` or `print`; the body is the head's instruction",
		"(one focus, clear conditions for acting, work, completion, and delivery).",
		"To create or tune a head, write the file with your file tools, then add",
		"it: files are re-discovered on every call. Swap heads when the work",
		"changes phase.",
	].join(" ");
}

export function capabilityScopedManagementOnlyHydraDescription(userHeadDir) {
	return [
		"This tool is unavailable to an observer unless its head tool allowlist explicitly includes hydra; an observer without that grant must not call it.",
		managementOnlyHydraDescription(userHeadDir),
	].join(" ");
}

export function validateManagementOnlyParams(value) {
	if (typeof value !== "object" || value === null) {
		throw new Error("hydra arguments must be an object");
	}
	const keys = Object.keys(value).sort();
	if (keys.join(",") !== "action,head,message,operation") {
		throw new Error("manage_heads accepts exactly action, operation, head, and message");
	}
	if (value.action !== "manage_heads") throw new Error('action must be "manage_heads"');
	if (value.operation !== "add" && value.operation !== "remove") {
		throw new Error('operation must be "add" or "remove"');
	}
	if (typeof value.head !== "string" || value.head.trim() === "") {
		throw new Error("head must be a non-empty string");
	}
	if (typeof value.message !== "string" || value.message.trim() === "") {
		throw new Error("message must be a non-empty string");
	}
	if (value.message.length > 1000) throw new Error("message must not exceed 1000 characters");
	return {
		action: "manage_heads",
		operation: value.operation,
		head: value.head,
		message: value.message,
	};
}

/**
 * Strict by design: no code-fence stripping, embedded-object extraction, key
 * aliases, or repairs. Invalid output has no delivery effect.
 */
export function parseToolFreeDecision(text) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return { decision: null, error: "invalid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { decision: null, error: "decision must be an object" };
	}
	if (Object.keys(value).sort().join(",") !== "delivery,message") {
		return { decision: null, error: "decision accepts exactly delivery and message" };
	}
	if (!["none", "print", "queue", "steer", "interrupt"].includes(value.delivery)) {
		return { decision: null, error: "invalid delivery" };
	}
	if (typeof value.message !== "string") {
		return { decision: null, error: "message must be a string" };
	}
	if (value.message.length > 1000) {
		return { decision: null, error: "message must not exceed 1000 characters" };
	}
	try {
		return { decision: decisionFromCompletion(value.delivery, value.message), error: null };
	} catch (error) {
		return { decision: null, error: error instanceof Error ? error.message : String(error) };
	}
}

export function parseActionDecision(text) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return { decision: null, error: "invalid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { decision: null, error: "decision must be an object" };
	}
	if (Object.keys(value).sort().join(",") !== "action,delivery,message") {
		return { decision: null, error: "decision accepts exactly action, delivery, and message" };
	}
	if (value.action !== "complete_observation") {
		return { decision: null, error: 'action must be "complete_observation"' };
	}
	return parseToolFreeDecision(JSON.stringify({ delivery: value.delivery, message: value.message }));
}

export function parseDeliveryActionDecision(text) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return { decision: null, error: "invalid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { decision: null, error: "decision must be an object" };
	}
	if (Object.keys(value).sort().join(",") !== "action,message") {
		return { decision: null, error: "decision accepts exactly action and message" };
	}
	if (!["noop", "print", "queue", "steer", "interrupt"].includes(value.action)) {
		return { decision: null, error: "invalid action" };
	}
	return parseToolFreeDecision(
		JSON.stringify({
			delivery: value.action === "noop" ? "none" : value.action,
			message: value.message,
		}),
	);
}

export function parseAssessedDecision(text) {
	let value;
	try {
		value = JSON.parse(text.trim());
	} catch {
		return { decision: null, error: "invalid JSON" };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { decision: null, error: "decision must be an object" };
	}
	if (Object.keys(value).sort().join(",") !== "assessment,delivery,message") {
		return { decision: null, error: "decision accepts exactly assessment, delivery, and message" };
	}
	if (typeof value.assessment !== "string" || value.assessment.trim() === "") {
		return { decision: null, error: "assessment must be a non-empty string" };
	}
	return parseToolFreeDecision(JSON.stringify({ delivery: value.delivery, message: value.message }));
}

export function parseFindingOnlyProbe(text) {
	const value = text.trim();
	if (value === "NO_FEEDBACK") {
		return { decision: decisionFromCompletion("none", ""), error: null };
	}
	if (value === "" || value.length > 1000) {
		return { decision: null, error: value === "" ? "empty response" : "finding exceeds 1000 characters" };
	}
	return { decision: decisionFromCompletion("steer", value), error: null };
}

export function parseMessageFooterDecision(text) {
	const value = text.trim();
	if (value === "NO_FEEDBACK") {
		return { decision: decisionFromCompletion("none", ""), error: null };
	}
	const match = value.match(/\nDELIVERY: (print|queue|steer|interrupt)$/);
	if (!match) {
		return { decision: null, error: "feedback must end with an exact DELIVERY footer" };
	}
	const message = value.slice(0, match.index).trim();
	if (message === "" || message.length > 1000) {
		return { decision: null, error: message === "" ? "message must be non-empty" : "message exceeds 1000 characters" };
	}
	return { decision: decisionFromCompletion(match[1], message), error: null };
}

export function parseUnifiedFooterDecision(text) {
	const value = text.trim();
	if (value === "DELIVERY: none") {
		return { decision: decisionFromCompletion("none", ""), error: null };
	}
	return parseMessageFooterDecision(value);
}

function snapshot(tools, activeHeads) {
	if (activeHeads === undefined || !tools?.includes("hydra")) return "";
	return ` Hydra snapshot at observation start: active heads are ${activeHeads.join(", ") || "none"}; later hydra tool results supersede this snapshot.`;
}

function allowance(tools) {
	return tools === undefined ? "the available tools" : `only these tools: ${tools.join(", ")}`;
}

function postChange(afterChange) {
	if (afterChange === "print") {
		return 'After a successful write or edit, return delivery "print" with a note describing it; the runtime enforces this.';
	}
	if (afterChange === "noop") {
		return 'After a successful write or edit, return delivery "none" with message "" because the changed file is the work product; the runtime enforces this.';
	}
	return "";
}

function textCompletion(head) {
	return `When finished, reply with exactly one JSON object and no other text: ${TOOL_FREE_DECISION_SHAPE}. Use delivery "none" with message "" when no feedback is warranted. Otherwise keep message non-empty and concise, ideally under 240 characters. Choose delivery by who must act and when: "print" is a user-only note when the agent need not act; "queue" is for agent action that can wait until its next turn; "steer" is for an agent correction needed before current work continues; "interrupt" is only for an emergency that must abort the run. Don't prefix message with [${head}].`;
}

export function buildToolFreeObservationPrompt(head, instruction, tools, options = {}) {
	if (headActs(tools)) {
		return `<system-reminder>Side watcher with tool access.${snapshot(tools, options.activeHeads)} You may use ${allowance(tools)} to check facts or act on your lens; the main agent does not see your tool calls, only files you change and feedback you route. manage_heads is available only when hydra is among your allowed work tools. A successful manage_heads change prints its own receipt automatically; do not repeat it. Removing your own head successfully completes the observation; do not return a decision afterward.

LENS: ${instruction}

${postChange(options.afterChange)} ${textCompletion(head)}</system-reminder>`;
	}
	return `<system-reminder>Side watcher. You have no work tools. Review the trajectory through the lens below.

LENS: ${instruction}

${textCompletion(head)} No tools, no "let me check...", no follow-up turn, and no unsupported claims.</system-reminder>`;
}

export function buildToolFreeObservationEnvelope(head, tools, options = {}) {
	const authority = `The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.`;
	if (headActs(tools)) {
		return `Side watcher with tool access. ${authority}${snapshot(tools, options.activeHeads)} You may use ${allowance(tools)} to check facts or act on the lens; the main agent does not see your tool calls, only files you change and feedback you route. manage_heads is available only when hydra is among your allowed work tools. A successful manage_heads change prints its own receipt automatically; do not repeat it. Removing your own head successfully completes the observation; do not return a decision afterward.

${postChange(options.afterChange)} ${textCompletion(head)}`;
	}
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full except where it conflicts with this protocol. The lens alone defines scope, intervention criteria, suppression, and deduplication; do not broaden it. Review the visible trajectory. You have no work tools. When finished, reply with exactly one JSON object and no other text: ${TOOL_FREE_DECISION_SHAPE}. Use delivery "none" with message "" when no feedback is warranted. Otherwise keep message non-empty and concise, ideally under 240 characters. Choose delivery by who must act and when: "print" is a user-only note when the agent need not act; "queue" is for agent action that can wait until its next turn; "steer" is for an agent correction needed before current work continues; "interrupt" is only for an emergency that must abort the run. No tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].`;
}

/**
 * Causal candidate for judge-only heads. The provider must still see the
 * driver's tool schemas for cache-prefix parity, even though the runtime does
 * not grant those tools to this head. Make that distinction explicit instead
 * of presenting the model with a visible schema and an unexplained "no tools".
 */
export function buildCacheAwareToolFreeObservationEnvelope(head, tools, options = {}) {
	const envelope = buildToolFreeObservationEnvelope(head, tools, options);
	if (headActs(tools)) return envelope;
	return envelope.replace(
		"You have no work tools.",
		"You have no executable work tools. Any visible tool schemas belong to the driver's cached request prefix; they are unavailable to this observation and must not be called.",
	);
}

export function buildActionToolFreeObservationEnvelope(head, tools, options = {}) {
	return buildToolFreeObservationEnvelope(head, tools, options).replace(
		TOOL_FREE_DECISION_SHAPE,
		ACTION_DECISION_SHAPE,
	);
}

export function buildDeliveryActionToolFreeObservationEnvelope(head, tools, options = {}) {
	return buildToolFreeObservationEnvelope(head, tools, options)
		.replace(TOOL_FREE_DECISION_SHAPE, DELIVERY_ACTION_DECISION_SHAPE)
		.replace('Use delivery "none"', 'Use action "noop"')
		.replace("Choose delivery by", "Choose action by");
}

function insertBeforeTextCompletion(envelope, instruction) {
	const marker = "When finished, reply with exactly one JSON object";
	if (!envelope.includes(marker)) throw new Error("tool-free completion marker not found");
	return envelope.replace(marker, `${instruction} ${marker}`);
}

/** Lean hypothesis: text needs an explicit semantic commit point before serialization. */
export function buildCommitPointToolFreeObservationEnvelope(head, tools, options = {}) {
	return insertBeforeTextCompletion(
		buildToolFreeObservationEnvelope(head, tools, options),
		"Treat the final JSON as a commit point: complete the lens review before serializing it, then check whether semantically equivalent feedback is already visible since the latest ordinary user task in the driver trajectory (excluding this lens handoff). Deliver a fresh finding warranted by the lens; return none for an already-delivered or unwarranted one. A distinct finding is not a duplicate merely because another lens already spoke.",
	);
}

/** Structured hypothesis: make the review and novelty gates explicit but private. */
export function buildDecisionSequenceToolFreeObservationEnvelope(head, tools, options = {}) {
	return insertBeforeTextCompletion(
		buildToolFreeObservationEnvelope(head, tools, options),
		"Before serializing, privately complete this sequence: (1) apply the lens to the latest work, examining concrete evidence and any assumptions, boundaries, success paths, failure paths, or observable effects relevant to that lens; (2) select the strongest finding that crosses the lens's own intervention threshold; (3) scan feedback since the latest ordinary user task in the driver trajectory, excluding this lens handoff, and suppress the finding only if semantically equivalent feedback is already visible and no material new evidence changes it; (4) if the finding remains fresh, choose its route by who must act and when. Return only the final JSON, never this analysis.",
	);
}

/** Clarify routing for live review without changing what the lens may find. */
export function buildReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	return insertBeforeTextCompletion(
		buildToolFreeObservationEnvelope(head, tools, options),
		"Check novelty before routing: return none when semantically equivalent feedback is already visible since the latest ordinary user task and no material new evidence changes it. For a fresh finding about the work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that the agent could address it on a later turn does not make it queue. Use queue only for genuinely deferrable follow-up that need not change or verify the current work before it continues.",
	);
}

/** The routing candidate plus the smallest truthful cached-tool boundary. */
export function buildCacheSafeReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	const envelope = buildReviewRoutingToolFreeObservationEnvelope(head, tools, options);
	if (headActs(tools)) return envelope;
	return envelope.replace(
		"You have no work tools.",
		"You have no work tools. Visible tool schemas are inert cached context for this observation; do not call them.",
	);
}

/** Teach the observer how routed feedback is represented in the captured driver trajectory. */
export function buildTagAwareReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	return insertBeforeTextCompletion(
		buildReviewRoutingToolFreeObservationEnvelope(head, tools, options),
		"In the driver trajectory, a user-role message whose text begins with a bracketed head tag ([<head-name>]) is previously delivered lens feedback, not a new ordinary user task. It does not reset the novelty window, and semantically matching tagged feedback counts as already visible.",
	);
}

/**
 * Causal hypothesis: in text generation, make the model formulate or suppress
 * the feedback before it serializes the routing category. The accepted object
 * and every semantic rule remain identical; only the demonstrated key order
 * changes.
 */
export function buildMessageFirstReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	return buildReviewRoutingToolFreeObservationEnvelope(head, tools, options).replace(
		TOOL_FREE_DECISION_SHAPE,
		MESSAGE_FIRST_DECISION_SHAPE,
	);
}

/** Test whether text completion is treating the shortest no-feedback form as a default. */
export function buildConclusiveNoneReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	return insertBeforeTextCompletion(
		buildReviewRoutingToolFreeObservationEnvelope(head, tools, options),
		'Delivery "none" is a review conclusion, not a shortcut: use it only when the full lens finds no warranted fresh feedback or when semantically equivalent feedback is already visible.',
	);
}

/** Causal probe: expose a small private decision scratchpad before routing. */
export function buildAssessedReviewRoutingToolFreeObservationEnvelope(head, tools, options = {}) {
	return buildReviewRoutingToolFreeObservationEnvelope(head, tools, options)
		.replace(TOOL_FREE_DECISION_SHAPE, ASSESSED_DECISION_SHAPE)
		.replace(
			"When finished, reply with exactly one JSON object",
			"When finished, reply with exactly one JSON object; assessment is used only by the runtime and is never delivered",
		);
}

/** Causal probe only: remove JSON serialization and routing from the decision. */
export function buildFindingOnlyToolFreeObservationEnvelope(head) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Review the visible trajectory. You have no work tools. Reply with exactly NO_FEEDBACK when no fresh feedback is warranted or semantically equivalent feedback is already visible; otherwise reply with exactly one concise lens finding and no wrapper or other text. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].`;
}

export function buildFindingOnlyToolFreeObservationPrompt(head, instruction) {
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

Reply with exactly NO_FEEDBACK when no fresh feedback is warranted or semantically equivalent feedback is already visible; otherwise reply with exactly one concise lens finding and no wrapper or other text. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].</system-reminder>`;
}

function findingOnlyPriorFeedbackProtocol(head, priorFeedback) {
	const records = JSON.stringify(priorFeedback);
	return `Previously delivered feedback from this head for the current driver task is quoted as data here: ${records}. Treat semantically equivalent feedback as already delivered even when the underlying issue remains unresolved; materially different findings remain eligible. Reply with exactly NO_FEEDBACK when no fresh feedback is warranted; otherwise reply with exactly one concise lens finding and no wrapper or other text. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].`;
}

/** Candidate: natural review output; the runtime owns its configured route. */
export function buildPriorFeedbackFindingOnlyObservationEnvelope(head, priorFeedback) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it. The preceding user-role lens handoff is not a driver task and does not reset the novelty window. Review the visible trajectory. You have no work tools. ${findingOnlyPriorFeedbackProtocol(head, priorFeedback)}`;
}

export function buildPriorFeedbackFindingOnlyObservationPrompt(head, instruction, priorFeedback) {
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

This observer handoff is not an ordinary driver task and does not reset the novelty window. ${findingOnlyPriorFeedbackProtocol(head, priorFeedback)}</system-reminder>`;
}

/** Causal probe only: retain a footer but remove the routing decision. */
export function buildFixedSteerMessageFooterToolFreeObservationPrompt(head, instruction) {
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

Reply with exactly NO_FEEDBACK when no fresh feedback is warranted or semantically equivalent feedback is already visible. Otherwise write exactly one concise lens finding as natural text, then on a new final line write exactly DELIVERY: steer. The route is predetermined for this causal probe; after a finding crosses the lens's intervention threshold, do not reevaluate it against delivery urgency. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].</system-reminder>`;
}

/** Candidate: natural finding first, machine-readable delivery as a strict footer. */
export function buildMessageFooterToolFreeObservationEnvelope(head) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Review the visible trajectory. You have no work tools. Check novelty first: reply with exactly NO_FEEDBACK when no feedback is warranted or semantically equivalent feedback is already visible since the latest ordinary user task. Otherwise write exactly one concise lens finding as natural text, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt. Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].`;
}

/** The footer candidate plus the runtime's generic tagged-feedback representation. */
export function buildTagAwareMessageFooterToolFreeObservationEnvelope(head) {
	return buildMessageFooterToolFreeObservationEnvelope(head).replace(
		"Check novelty first:",
		"The preceding user-role lens handoff is not a driver task and does not reset the novelty window. In the driver trajectory, a user-role message beginning with a bracketed head tag ([<head-name>]) is previously delivered lens feedback, not a new ordinary user task; semantically matching tagged feedback is already visible. Check novelty first:",
	);
}

/** Candidate: make this head's current-task delivery history explicit. */
export function buildPriorFeedbackMessageFooterToolFreeObservationEnvelope(head, priorFeedback) {
	const records = priorFeedback.length === 0 ? "[]" : JSON.stringify(priorFeedback);
	return buildMessageFooterToolFreeObservationEnvelope(head).replace(
		"Check novelty first:",
		`The preceding user-role lens handoff is not a driver task and does not reset the novelty window. Previously delivered feedback from this head for the current driver task is quoted as data here: ${records}. Treat semantically equivalent feedback as already delivered even when the underlying issue remains unresolved; materially different findings remain eligible. Check novelty first:`,
	);
}

/** The explicit-state candidate plus the measured current-work routing rule. */
export function buildStrongRoutingPriorFeedbackMessageFooterToolFreeObservationEnvelope(head, priorFeedback) {
	return buildPriorFeedbackMessageFooterToolFreeObservationEnvelope(head, priorFeedback).replace(
		"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
		"Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
	);
}

/** Final-format candidate: every decision uses the same exact delivery footer. */
export function buildUnifiedFooterToolFreeObservationEnvelope(head, priorFeedback) {
	return buildStrongRoutingPriorFeedbackMessageFooterToolFreeObservationEnvelope(head, priorFeedback).replace(
		"reply with exactly NO_FEEDBACK",
		"reply with exactly DELIVERY: none",
	);
}

/**
 * Bounded delivery context: one completed delivery for this head, plus every
 * queue/steer delivery that the driver has not consumed yet across all heads.
 * Event order is chronological; the final matching completed event wins.
 */
export function selectLastSuccessfulPlusPending(events, head) {
	let lastSuccessfulForThisHead = null;
	const pendingAcrossHeads = [];
	const deliveries = new Set(["print", "queue", "steer", "interrupt"]);
	const statuses = new Set(["delivered", "pending", "failed", "consumed"]);
	for (const event of events) {
		if (
			typeof event !== "object" ||
			event === null ||
			typeof event.head !== "string" ||
			typeof event.delivery !== "string" ||
			typeof event.message !== "string" ||
			typeof event.status !== "string"
		) {
			throw new Error("feedback events require head, delivery, message, and status strings");
		}
		if (!deliveries.has(event.delivery) || !statuses.has(event.status) || event.message.trim() === "") {
			throw new Error("feedback events require a routed delivery, non-empty message, and known status");
		}
		const record = { head: event.head, delivery: event.delivery, message: event.message };
		if (event.status === "delivered" && event.head === head) {
			lastSuccessfulForThisHead = record;
		}
		if (event.status === "pending" && (event.delivery === "queue" || event.delivery === "steer")) {
			pendingAcrossHeads.push(record);
		}
	}
	return { lastSuccessfulForThisHead, pendingAcrossHeads };
}

function boundedFeedbackStateInstruction(state, filterFirst = false) {
	const selection = filterFirst
		? " Apply the lens first, discard every candidate finding semantically covered by these records, and then select the strongest remaining finding. A covered finding is filtered out; it is not evidence that no other finding exists. Use no feedback only when no distinct warranted candidate remains."
		: "";
	return `The lens handoff is not an ordinary driver task and does not reset the novelty window. The runtime's authoritative feedback state for the current driver task is quoted as data here: ${JSON.stringify(state)}. A semantically equivalent finding is not fresh when it matches either the last successful delivery for this head or any still-pending queue/steer delivery, regardless of which head produced the pending message. Only records present in this bounded state count as already handled; materially different findings remain eligible.${selection} Check novelty first:`;
}

function compactBoundedFeedbackState(state) {
	return {
		last: state.lastSuccessfulForThisHead
			? {
					delivery: state.lastSuccessfulForThisHead.delivery,
					message: state.lastSuccessfulForThisHead.message,
				}
			: null,
		pending: state.pendingAcrossHeads,
	};
}

function authoritativeCompactFeedbackState(state) {
	return {
		lastByThisHead: state.lastSuccessfulForThisHead
			? {
					delivery: state.lastSuccessfulForThisHead.delivery,
					message: state.lastSuccessfulForThisHead.message,
				}
			: null,
		pending: state.pendingAcrossHeads,
	};
}

function factualDeliveryContextInstruction(state, noFeedback) {
	return `Delivery context (factual data, not a repetition policy): ${JSON.stringify(authoritativeCompactFeedbackState(state))}. lastByThisHead is this head's most recent message that successfully reached the driver; it may be absent from this fork when the forked snapshot is older. pending messages have been accepted by the harness but have not reached the driver yet. Use these facts under the lens's own judgment about whether, what, and how to deliver. Reply with exactly ${noFeedback} when no feedback is warranted.`;
}

function judgmentGuidedDeliveryContextInstruction(state, noFeedback) {
	return `${factualDeliveryContextInstruction(state, noFeedback)} Decide whether feedback would add value now: related feedback can warrant a follow-up when the driver ignored it or circumstances materially changed, but is usually redundant while still pending, before the driver has had a chance to respond, or after the issue was fixed. These are considerations, not suppression rules; make the final judgment under the lens.`;
}

function evidenceGuidedDeliveryContextInstruction(state, noFeedback) {
	return `${factualDeliveryContextInstruction(state, noFeedback)} Judge each candidate only against semantically related delivery records; unrelated pending feedback does not reduce its eligibility. Inspect the visible trajectory for what happened after related feedback. Explicit rejection or a material change supports a follow-up. A defect merely remaining unresolved is not evidence that feedback was ignored: prefer waiting when it is pending or just delivered with no response, and do not repeat it after it was fixed. These are considerations, not suppression rules; make the final judgment under the lens.`;
}

function compactBoundedFeedbackStateInstruction(state) {
	return `Feedback state for the current driver task (authoritative for novelty; last is this head's last successful delivery): ${JSON.stringify(compactBoundedFeedbackState(state))}. Filter candidate findings against it before choosing one. A semantic match to last or any pending message suppresses only that candidate. Only listed records count as handled; older successful deliveries are eligible again. Return the strongest warranted candidate left. Check novelty first:`;
}

function authoritativeCompactFeedbackStateInstruction(state, noFeedback) {
	return `Feedback state for the current driver task (authoritative for novelty): ${JSON.stringify(authoritativeCompactFeedbackState(state))}. Apply the lens, discard candidates semantically matching lastByThisHead or any pending message, then choose the strongest remaining. A match suppresses only that candidate. Only listed records count as handled; older successful deliveries are eligible again. Reply with exactly ${noFeedback} only if no warranted candidate remains.`;
}

function replaceGeneralNoveltyClause(value, replacement, noFeedback) {
	const clause = `Check novelty first: reply with exactly ${noFeedback} when no feedback is warranted or semantically equivalent feedback is already visible since the latest ordinary user task.`;
	if (!value.includes(clause)) throw new Error("general novelty clause not found");
	return value.replace(clause, replacement);
}

export function buildLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return buildMessageFooterToolFreeObservationEnvelope(head)
		.replace("Check novelty first:", boundedFeedbackStateInstruction(state))
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replace("reply with exactly NO_FEEDBACK", "reply with exactly DELIVERY: none");
}

export function buildFilterFirstLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return buildMessageFooterToolFreeObservationEnvelope(head)
		.replace("Check novelty first:", boundedFeedbackStateInstruction(state, true))
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replace("reply with exactly NO_FEEDBACK", "reply with exactly DELIVERY: none");
}

export function buildCompactLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return buildMessageFooterToolFreeObservationEnvelope(head)
		.replace("Check novelty first:", compactBoundedFeedbackStateInstruction(state))
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replace("reply with exactly NO_FEEDBACK", "reply with exactly DELIVERY: none");
}

export function buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationEnvelope(head),
		authoritativeCompactFeedbackStateInstruction(state, "NO_FEEDBACK"),
		"NO_FEEDBACK",
	)
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replaceAll("NO_FEEDBACK", "DELIVERY: none");
}

export function buildFactualLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationEnvelope(head),
		factualDeliveryContextInstruction(state, "NO_FEEDBACK"),
		"NO_FEEDBACK",
	)
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replaceAll("NO_FEEDBACK", "DELIVERY: none");
}

export function buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationEnvelope(head),
		judgmentGuidedDeliveryContextInstruction(state, "NO_FEEDBACK"),
		"NO_FEEDBACK",
	)
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replaceAll("NO_FEEDBACK", "DELIVERY: none");
}

export function buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationEnvelope(head, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationEnvelope(head),
		evidenceGuidedDeliveryContextInstruction(state, "NO_FEEDBACK"),
		"NO_FEEDBACK",
	)
		.replace(
			"Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.",
			"Choose by who must act and when. For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run.",
		)
		.replaceAll("NO_FEEDBACK", "DELIVERY: none");
}

/**
 * The same protocol as the split-role envelope, adapted to providers whose
 * normal handoff is one combined user message containing both lens and
 * observer protocol. Keep this separate from the envelope builder so the A/B
 * does not accidentally test an impossible "preceding user message".
 */
export function buildMessageFooterToolFreeObservationPrompt(head, instruction, options = {}) {
	const records = options.priorFeedback === undefined ? null : JSON.stringify(options.priorFeedback);
	const novelty =
		options.feedbackStateInstruction !== undefined
			? options.feedbackStateInstruction
			: options.feedbackState !== undefined
			? boundedFeedbackStateInstruction(options.feedbackState, options.filterFirst === true)
		: records === null
			? "Check novelty first:"
			: `This observer handoff is not an ordinary driver task and does not reset the novelty window. Previously delivered feedback from this head for the current driver task is quoted as data here: ${records}. Treat semantically equivalent feedback as already delivered even when the underlying issue remains unresolved; materially different findings remain eligible. Check novelty first:`;
	const noFeedback = options.unifiedNone ? "DELIVERY: none" : "NO_FEEDBACK";
	const routing = options.strongRouting
		? "Choose by who must act and when. For a fresh finding about work currently underway, use steer when leaving unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run."
		: "Choose by who must act and when: print is a user-only note when the agent need not act; queue is agent action that can wait; steer is an agent correction needed before current work continues; interrupt is only an emergency that must abort the run.";
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

${novelty} reply with exactly ${noFeedback} when no feedback is warranted or semantically equivalent feedback is already visible since the latest ordinary user task. Otherwise write exactly one concise lens finding as natural text, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt. ${routing} No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].</system-reminder>`;
}

export function buildUnifiedFooterToolFreeObservationPrompt(head, instruction, priorFeedback) {
	return buildMessageFooterToolFreeObservationPrompt(head, instruction, {
		priorFeedback,
		strongRouting: true,
		unifiedNone: true,
	});
}

export function buildLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return buildMessageFooterToolFreeObservationPrompt(head, instruction, {
		feedbackState: state,
		strongRouting: true,
		unifiedNone: true,
	});
}

export function buildFilterFirstLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return buildMessageFooterToolFreeObservationPrompt(head, instruction, {
		feedbackState: state,
		filterFirst: true,
		strongRouting: true,
		unifiedNone: true,
	});
}

export function buildCompactLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return buildMessageFooterToolFreeObservationPrompt(head, instruction, {
		feedbackStateInstruction: compactBoundedFeedbackStateInstruction(state),
		strongRouting: true,
		unifiedNone: true,
	});
}

export function buildAuthoritativeCompactLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationPrompt(head, instruction, {
			strongRouting: true,
			unifiedNone: true,
		}),
		authoritativeCompactFeedbackStateInstruction(state, "DELIVERY: none"),
		"DELIVERY: none",
	);
}

export function buildFactualLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationPrompt(head, instruction, {
			strongRouting: true,
			unifiedNone: true,
		}),
		factualDeliveryContextInstruction(state, "DELIVERY: none"),
		"DELIVERY: none",
	).replace(
		"For a fresh finding about work currently underway",
		"For feedback about work currently underway",
	);
}

export function buildJudgmentGuidedLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationPrompt(head, instruction, {
			strongRouting: true,
			unifiedNone: true,
		}),
		judgmentGuidedDeliveryContextInstruction(state, "DELIVERY: none"),
		"DELIVERY: none",
	).replace(
		"For a fresh finding about work currently underway",
		"For feedback about work currently underway",
	);
}

export function buildEvidenceGuidedLastPlusPendingUnifiedFooterObservationPrompt(head, instruction, state) {
	return replaceGeneralNoveltyClause(
		buildMessageFooterToolFreeObservationPrompt(head, instruction, {
			strongRouting: true,
			unifiedNone: true,
		}),
		evidenceGuidedDeliveryContextInstruction(state, "DELIVERY: none"),
		"DELIVERY: none",
	).replace(
		"For a fresh finding about work currently underway",
		"For feedback about work currently underway",
	);
}

/**
 * The already-approved OpenAI cleanup: retain typed completion and every
 * semantic rule, but state each delivery meaning only once.
 */
export function buildDeduplicatedToolEnvelope(head, tools, options = {}) {
	const authority = `The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.`;
	const completion = `When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" with message "" when no feedback is warranted. Otherwise keep message non-empty and concise, ideally under 240 characters. Choose delivery by recipient and urgency: "print" is a user-only note; "queue" is agent action later; "steer" is agent action before current work continues; "interrupt" is emergency abort. Don't prefix message with [${head}].`;
	if (headActs(tools)) {
		return `Side watcher with tool access. ${authority}${snapshot(tools, options.activeHeads)} You may use ${allowance(tools)} to check facts or act on the lens; the main agent does not see your tool calls, only files you change and feedback you route. The hydra action complete_observation is always available. manage_heads is available only when hydra is among your allowed work tools. A successful manage_heads change prints its own receipt automatically; do not repeat it. Removing your own head successfully completes the observation; do not call complete_observation afterward.

${postChange(options.afterChange)} ${completion}`;
	}
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full except where it conflicts with this protocol. The lens alone defines scope, intervention criteria, suppression, and deduplication; do not broaden it. Review the visible trajectory. You have no work tools. When finished, call hydra exactly once, alone in its turn, with action "complete_observation". Use delivery "none" and message "" when no feedback is warranted. Otherwise keep the message concise, ideally under 240 characters. Choose delivery by recipient and urgency: print is a user-only note; queue is agent action later; steer is agent action before current work continues; interrupt is emergency abort. No tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].`;
}
