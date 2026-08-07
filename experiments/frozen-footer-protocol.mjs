/**
 * The frozen pre-ENUM judge protocols, moved out of the product tree.
 *
 * Two study-era contracts live here: the footer-grammar judge contract (MAIN
 * in the trajectory studies) and the legacy Anthropic judge control. Production
 * judge-only heads use the enumerated ENUM-SO2 builders in `../utils.ts`;
 * nothing in this module is reachable from `index.ts`.
 *
 * Every string is a recorded-study artifact and must stay byte-identical:
 * `arm-registry.check.mjs` pins the rendered handoffs, and
 * `delivery-context-golden.test.mjs` pins the legacy control by hash. The
 * module therefore owns frozen copies of shared prompt text (the evidence
 * guidance) instead of tracking later edits to the live contract.
 */

import { decisionFromCompletion } from "../utils.ts";

const LEGACY_DECISION_SHAPE =
	'{"action":"noop|print|queue|steer|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}';

/** Frozen copy of the study-era evidence guidance; the live text may evolve, this must not. */
const EVIDENCE_GUIDANCE =
	"Judge each candidate only against semantically related delivery records; unrelated pending feedback does not reduce its eligibility. Inspect the visible trajectory for what happened after related feedback. Explicit rejection or a material change supports a follow-up. A defect merely remaining unresolved is not evidence that feedback was ignored: prefer waiting when it is pending or just delivered with no response, and do not repeat it after it was fixed. These are considerations, not suppression rules; make the final judgment under the lens.";

/** Frozen footer-experiment rendering; production uses enumeratedDeliveryContext. */
function deliveryContextFacts(context) {
	return `Delivery context (factual data, not a repetition policy): ${JSON.stringify(context)}. lastByThisHead is this head's most recent delivery accepted by the runtime; depending on its route, it may have reached the user or durable session state rather than the driver, and it may be absent when this fork's snapshot is older. pending messages are held in a live Pi queue and have not reached the driver yet. Use these facts under the lens's own judgment about whether, what, and how to deliver.`;
}

function factualDeliveryContext(context) {
	return `${deliveryContextFacts(context)} Reply with exactly DELIVERY: none when no feedback is warranted. ${EVIDENCE_GUIDANCE}`;
}

/** Frozen footer experiment builder. Production uses the enumerated builder. */
export function buildJudgeObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Review the visible trajectory. You have no work tools. ${factualDeliveryContext(context)} Otherwise write exactly one concise lens finding as natural text, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt. Choose by who must act and when. For feedback about work currently underway, use steer when leaving it unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].`;
}

/** Frozen combined-user footer analogue retained for experiment replay. */
export function buildJudgeObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. You have no work tools. Review the visible trajectory through the lens below. Follow the lens in full; the lens alone defines scope, intervention criteria, suppression, and deduplication. Do not broaden it.

LENS: ${instruction}

${factualDeliveryContext(context)} Otherwise write exactly one concise lens finding as natural text, then on a new final line write DELIVERY: followed by print, queue, steer, or interrupt. Choose by who must act and when. For feedback about work currently underway, use steer when leaving unresolved would leave that work incorrect, unsafe, incomplete, or unverified; the fact that it could be addressed on a later turn does not make it queue. Use print only when the agent need not act, queue only for genuinely deferrable follow-up, and interrupt only for an emergency that must abort the run. No tools, no follow-up turn, and no unsupported claims. Don't prefix the finding with [${head}].</system-reminder>`;
}

/** Strictly parse the measured tool-free judge completion contract. */
export function parseFooterDecision(text) {
	const value = text.trim();
	const deliveryMarkers = [...value.matchAll(/DELIVERY: (none|print|queue|steer|interrupt)/g)];
	// `none` carries no routed message, so one exact standalone marker is
	// unambiguous even when the model puts private rationale before or after it.
	// Multiple markers remain invalid rather than guessing which one won.
	if (
		deliveryMarkers.length === 1 &&
		deliveryMarkers[0][1] === "none" &&
		/(?:^|\n)DELIVERY: none(?=\n|$)/.test(value)
	) {
		return { decision: decisionFromCompletion("none", ""), error: null };
	}
	if (deliveryMarkers.length > 1) {
		return { decision: null, error: "feedback contains multiple DELIVERY markers" };
	}
	// A routed footer is the decision; everything before it is the message.
	const footer = value.match(/(?:^|\s)DELIVERY: (none|print|queue|steer|interrupt)$/);
	if (!footer) {
		return { decision: null, error: "feedback must end with an exact DELIVERY footer" };
	}
	const message = value.slice(0, footer.index).trim();
	if (message.length === 0 || message.length > 1000) {
		return {
			decision: null,
			error: message.length === 0 ? "message must be non-empty" : "message exceeds 1000 characters",
		};
	}
	return { decision: decisionFromCompletion(footer[1], message), error: null };
}

export function footerFormatCorrection(error) {
	return `FORMAT CORRECTION: The preceding completion was rejected: ${error}. Preserve its semantic decision and finding. Do not call any visible tools; they belong to the cached driver request and are unavailable to this observation. Reply only with either DELIVERY: none as the entire response, or one concise message followed by a final DELIVERY: print|queue|steer|interrupt line.`;
}

/**
 * Frozen control used by historical experiments: the pre-ENUM Anthropic
 * judge-only prompt. Production judge-only heads use
 * buildEnumeratedJudgeObservationPrompt instead.
 */
export function buildLegacyAnthropicJudgePrompt(head, instruction) {
	return `<system-reminder>Side watcher. You have no work tools. Review the trajectory through the lens below.

LENS: ${instruction}

Reply with one JSON object, nothing else:
${LEGACY_DECISION_SHAPE}

Noop unless something warrants feedback. Print only when the user should see a note but the agent need not act. Queue agent action that can wait. Steer an agent correction needed before current work continues. Interrupt only for emergencies. No tools, no "let me check...", no follow-up turn, and no unsupported claims. Don't prefix message with [${head}].</system-reminder>`;
}
