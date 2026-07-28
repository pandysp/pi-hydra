/**
 * Development candidate for factual, head-decided delivery context.
 *
 * This stays outside production until it clears the held-out development
 * corpus. The sequence is the mechanism under test: find, contextualize,
 * then route. It contains no head-, model-, provider-, or case-specific rule.
 */

import { decisionFromCompletion } from "../utils.ts";

function candidate1Context(context) {
	return `Delivery context is factual timing evidence, not a veto: ${JSON.stringify(context)}. lastByThisHead is this head's latest delivery accepted by the runtime; depending on its route, it may have reached the user, durable session state, or the driver, and a newer delivery may be absent from this fork. pending contains every queue or steer message still held by Pi and not yet consumed by the driver.

Decide in this order:
1. Apply the lens first and identify the strongest concrete candidate, if any.
2. Compare that candidate only with semantically related delivery records and the visible reaction after them. Unrelated records do not affect it. A still-pending match has not reached the driver. A newly accepted or visible delivery with no later response has not been ignored merely because the defect remains; normally wait. Explicit rejection or a material change can warrant a follow-up. A fixed issue does not. These facts inform the lens; they do not forbid a justified repeat.
3. Choose delivery by recipient and timing: print when only the user must act; queue for useful agent work outside the current task; steer for agent action needed before current work continues; interrupt only when harmful work is already in flight and must be aborted now.`;
}

function completion(head) {
	return `When no feedback is warranted, end with DELIVERY: none. Otherwise write one concise finding, then a final line DELIVERY: print|queue|steer|interrupt. You have no work tools or follow-up turn. Make no unsupported claims and do not prefix the finding with [${head}].`;
}

export function buildCandidateObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; it alone defines scope and the intervention threshold. Review the visible trajectory.\n\n${candidate1Context(context)}\n\n${completion(head)}`;
}

export function buildCandidateObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. Review the visible trajectory through the complete lens below. Follow it in full; it alone defines scope and the intervention threshold.\n\nLENS: ${instruction}\n\n${candidate1Context(context)}\n\n${completion(head)}</system-reminder>`;
}

function candidate2Context(context) {
	return `Delivery context is factual timing evidence, not a runtime veto: ${JSON.stringify(context)}. lastByThisHead is this head's latest delivery accepted by the runtime; depending on its route, it may have reached the user, durable session state, or the driver, and a newer delivery may be absent from this fork. pending contains every queue or steer message still held by Pi and not yet consumed by the driver.

Decide in this order:
1. Apply the lens first and identify the strongest concrete candidate, if any.
2. Compare that candidate only with semantically related records and the visible reaction after them. Unrelated records have no effect. If an equivalent message is pending, the driver has not received it. If it was just accepted or is visible with no later response, there is no evidence the driver ignored it. In either case choose none unless the candidate adds material new evidence or requires an urgent escalation. Explicit rejection or material change can warrant a follow-up; a fixed issue does not. The head decides whether those facts justify repeating feedback.
3. Route for the coding driver, not this observer. Print only human-facing information when the driver need not act. Queue driver work that is outside the current task and can wait. Steer driver action needed to correct or verify the current task before completion. Interrupt only to abort an active operation whose imminent effect would cause serious, difficult-to-reverse harm; a severe code defect, rejection, or plan by itself is still steer.`;
}

export function buildCandidate2ObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; it alone defines scope and the intervention threshold. Review the visible trajectory.\n\n${candidate2Context(context)}\n\n${completion(head)}`;
}

export function buildCandidate2ObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. Review the visible trajectory through the complete lens below. Follow it in full; it alone defines scope and the intervention threshold.\n\nLENS: ${instruction}\n\n${candidate2Context(context)}\n\n${completion(head)}</system-reminder>`;
}

function candidate3Context(context) {
	return `Delivery context is factual timing evidence, not a runtime veto: ${JSON.stringify(context)}. lastByThisHead is this head's latest accepted delivery. pending contains queue or steer messages Pi has not yet given the driver.

Apply the lens first and identify the strongest concrete candidate. Compare only that candidate with semantically related records and the visible reaction after them; unrelated records have no effect. An equivalent pending message has not reached the driver, and an equivalent accepted or visible message with no later response has had no chance to be acted on. Do not repeat it merely because the defect remains. A changed impact, exposure, consequence, or material evidence is not equivalent and can warrant an update. Explicit rejection can warrant a repeat; a fixed issue does not. The head makes the final contextual judgment.

Route for the coding driver: print only human-facing action outside the driver's authority when the driver need not act; queue useful driver work outside the current task that can wait; steer driver action needed to correct or verify the current task before completion; interrupt only to abort an active operation whose imminent effect risks serious, difficult-to-reverse harm—not an ordinary defect, rejection, or plan.`;
}

function candidate3Completion(head) {
	return `You have no work tools; cached driver tools are unavailable and must not be called. End with DELIVERY: none when no feedback is warranted. Otherwise write one concise finding, then a final line DELIVERY: print|queue|steer|interrupt. Do not prefix it with [${head}].`;
}

export function buildCandidate3ObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens. Follow it in full; it alone defines scope and the intervention threshold. Review the visible trajectory.\n\n${candidate3Context(context)}\n\n${candidate3Completion(head)}`;
}

export function buildCandidate3ObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. You have no work tools; do not call visible driver tools. Review the visible trajectory through the complete lens below. Follow it in full; it alone defines scope and the intervention threshold.\n\nLENS: ${instruction}\n\n${candidate3Context(context)}\n\n${candidate3Completion(head)}</system-reminder>`;
}

function candidate4Context(context) {
	return `Delivery context is factual timing evidence, not a runtime veto: ${JSON.stringify(context)}. lastByThisHead is this head's latest accepted delivery. pending contains queue or steer messages Pi has not yet given the driver.

First apply the lens and identify the strongest concrete candidate. Then compare only that candidate with semantically related records and the visible reaction after them; unrelated records have no effect. An equivalent pending message has not reached the driver. An equivalent accepted or visible message with no later response has had no chance to be acted on. Choose none in those cases unless the candidate adds material new evidence or requires urgent escalation. A changed impact, exposure, or consequence is material rather than a duplicate. Explicit rejection can warrant a repeat; a fixed issue does not. The head decides whether the evidence meets these conditions.

After a candidate crosses the lens's intervention threshold, choose its route by who can act and when:
- steer: the driver must correct or verify the current task before completion;
- queue: the driver can act, but the work is outside the current task and can wait;
- print: only the human can perform the remaining action and the driver need not act;
- interrupt: an active operation must be aborted now because its imminent effect risks serious, difficult-to-reverse harm. An ordinary defect, rejection, or plan is not an interrupt.`;
}

function candidate4Prefix(head) {
	return `Side watcher. You have no work tools; cached driver tools are unavailable and must not be called. The complete ${head} lens alone defines scope and the intervention threshold.`;
}

export function buildCandidate4ObservationEnvelope(head, context) {
	return `${candidate4Prefix(head)} The preceding user message is that lens. Review the visible trajectory.\n\n${candidate4Context(context)}\n\n${completion(head)}`;
}

export function buildCandidate4ObservationPrompt(head, instruction, context) {
	return `<system-reminder>${candidate4Prefix(head)} Review the visible trajectory.\n\nLENS: ${instruction}\n\n${candidate4Context(context)}\n\n${completion(head)}</system-reminder>`;
}

const CONTEXT_RELATIONS = ["none", "new", "waiting", "follow_up", "resolved"];

function structuredContext(context) {
	return `Delivery evidence: ${JSON.stringify(context)}. lastByThisHead is this head's latest accepted delivery. pending contains queue or steer messages Pi has not yet given the driver.

First apply the lens and select the strongest concrete candidate, if any. Then choose its relation to semantically related evidence:
- none: no lens finding warrants feedback;
- new: the finding is not covered by related delivery evidence;
- waiting: equivalent feedback is pending or accepted/visible without a later driver response;
- follow_up: explicit rejection, changed impact, or material new evidence warrants another message;
- resolved: the related finding was fixed.
Unrelated records do not affect the candidate. The head—not the runtime—chooses this relation.

Choose delivery for the coding driver: steer for driver action needed in the current task; queue for driver work outside it that can wait; print when only the human can perform the remaining action; interrupt only to abort an active operation with imminent serious, difficult-to-reverse harm.`;
}

function structuredCompletion(head) {
	return `You have no work tools; cached driver tools are unavailable. End with exactly two footer lines. For none, waiting, or resolved, emit no finding and use DELIVERY: none. For new or follow_up, write one concise finding first and use print, queue, steer, or interrupt. Format:\nCONTEXT: none|new|waiting|follow_up|resolved\nDELIVERY: none|print|queue|steer|interrupt\nDo not prefix the finding with [${head}].`;
}

export function buildStructuredContextObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens; it alone defines scope and the intervention threshold. Review the visible trajectory.\n\n${structuredContext(context)}\n\n${structuredCompletion(head)}`;
}

export function buildStructuredContextObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. You have no work tools; do not call visible driver tools. Review the visible trajectory through the complete lens below; it alone defines scope and the intervention threshold.\n\nLENS: ${instruction}\n\n${structuredContext(context)}\n\n${structuredCompletion(head)}</system-reminder>`;
}

export function parseStructuredContextDecision(text) {
	const value = text.trim();
	const match = value.match(/(?:^|\n)CONTEXT: (none|new|waiting|follow_up|resolved)\nDELIVERY: (none|print|queue|steer|interrupt)$/);
	if (!match) return { decision: null, relation: null, error: "completion must end with exact CONTEXT and DELIVERY footers" };
	const relation = match[1];
	const delivery = match[2];
	if (!CONTEXT_RELATIONS.includes(relation)) {
		return { decision: null, relation: null, error: "unknown context relation" };
	}
	const silent = relation === "none" || relation === "waiting" || relation === "resolved";
	if (silent !== (delivery === "none")) {
		return { decision: null, relation, error: `context ${relation} is inconsistent with delivery ${delivery}` };
	}
	const message = value.slice(0, match.index).trim();
	if (!silent && message === "") {
		return { decision: null, relation, error: `context ${relation} requires a finding` };
	}
	try {
		return { decision: decisionFromCompletion(delivery, silent ? "" : message), relation, error: null };
	} catch (error) {
		return { decision: null, relation, error: error instanceof Error ? error.message : String(error) };
	}
}

export function structuredContextFormatCorrection(error) {
	return `FORMAT CORRECTION: The preceding completion was rejected: ${error}. Preserve its finding, context relation, and delivery decision. Do not call tools. Return only an optional concise finding followed by exact CONTEXT and DELIVERY footer lines. none, waiting, and resolved require DELIVERY: none and no finding; new and follow_up require a finding and print, queue, steer, or interrupt.`;
}

function structuredCandidateContext(context) {
	return `Delivery evidence: ${JSON.stringify(context)}. lastByThisHead is this head's latest accepted delivery. pending contains queue or steer messages Pi has not yet given the driver.

Apply the lens first and write the strongest concrete candidate before classifying it. Then relate that candidate only to semantically related evidence:
- none: there is no warranted candidate;
- new: the candidate is not covered by related delivery evidence;
- covered_no_response: equivalent feedback is pending or accepted/visible without a later driver response;
- follow_up: explicit rejection, changed impact, or material new evidence warrants another message;
- resolved: that candidate was fixed.
Unrelated records do not affect the candidate. The head chooses the candidate, relation, and delivery.

Route for the coding driver: steer for driver action needed in the current task; queue for driver work outside it that can wait; print when only the human can perform the remaining action; interrupt only to abort an active operation with imminent serious, difficult-to-reverse harm.`;
}

function structuredCandidateCompletion(head) {
	return `You have no work tools; cached driver tools are unavailable. Return exactly three single-line fields and no other text. CANDIDATE is private unless routed. Use literal none only when there is no candidate. covered_no_response and resolved require DELIVERY: none; new and follow_up require a routed delivery. Format:\nCANDIDATE: none|<one concise finding>\nRELATION: none|new|covered_no_response|follow_up|resolved\nDELIVERY: none|print|queue|steer|interrupt\nDo not prefix the candidate with [${head}].`;
}

export function buildStructuredCandidateObservationEnvelope(head, context) {
	return `Side watcher. The preceding user message is the complete ${head} lens; it alone defines scope and the intervention threshold. Review the visible trajectory.\n\n${structuredCandidateContext(context)}\n\n${structuredCandidateCompletion(head)}`;
}

export function buildStructuredCandidateObservationPrompt(head, instruction, context) {
	return `<system-reminder>Side watcher. You have no work tools; do not call visible driver tools. Review the visible trajectory through the complete lens below; it alone defines scope and the intervention threshold.\n\nLENS: ${instruction}\n\n${structuredCandidateContext(context)}\n\n${structuredCandidateCompletion(head)}</system-reminder>`;
}

export function parseStructuredCandidateDecision(text) {
	const value = text.trim();
	const match = value.match(/^CANDIDATE: ([^\n]+)\nRELATION: (none|new|covered_no_response|follow_up|resolved)\nDELIVERY: (none|print|queue|steer|interrupt)$/);
	if (!match) {
		return { decision: null, candidate: null, relation: null, error: "completion must contain exact CANDIDATE, RELATION, and DELIVERY lines" };
	}
	const candidate = match[1].trim();
	const relation = match[2];
	const delivery = match[3];
	const noCandidate = candidate === "none";
	if ((relation === "none") !== noCandidate) {
		return { decision: null, candidate, relation, error: `relation ${relation} is inconsistent with candidate ${candidate}` };
	}
	const silent = relation === "none" || relation === "covered_no_response" || relation === "resolved";
	if (silent !== (delivery === "none")) {
		return { decision: null, candidate, relation, error: `relation ${relation} is inconsistent with delivery ${delivery}` };
	}
	if (!noCandidate && candidate.length === 0) {
		return { decision: null, candidate, relation, error: "candidate must be non-empty" };
	}
	try {
		return {
			decision: decisionFromCompletion(delivery, silent ? "" : candidate),
			candidate,
			relation,
			error: null,
		};
	} catch (error) {
		return {
			decision: null,
			candidate,
			relation,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function structuredCandidateFormatCorrection(error) {
	return `FORMAT CORRECTION: The preceding completion was rejected: ${error}. Preserve the candidate, relation, and delivery. Do not call tools. Return exactly three single-line fields: CANDIDATE, RELATION, DELIVERY. none requires literal candidate none and DELIVERY: none; covered_no_response and resolved require a concrete candidate with DELIVERY: none; new and follow_up require a concrete candidate and routed delivery.`;
}
