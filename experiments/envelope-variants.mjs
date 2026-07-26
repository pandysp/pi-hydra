import { buildObservationEnvelope, buildObservationPrompt } from "../utils.ts";

/**
 * Candidate authority boundary for heads whose primary work may be review,
 * file maintenance, orchestration, or another tool-mediated task.
 *
 * Kept outside production until the paired generality experiment earns it.
 */
export function buildGeneralObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const reviewFocused = `The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.`;
	const general = `The preceding user message is the complete instruction for the ${head} head, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The head instruction alone defines its objective, scope, triggers, boundaries, and when work or feedback is warranted. Treat those as binding; do not broaden or reinterpret them.`;
	if (!current.includes(reviewFocused)) {
		throw new Error("production envelope no longer contains the expected review-focused authority boundary");
	}
	return current.replace(reviewFocused, general);
}

/**
 * Policy/mechanism split: the head owns every behavioral choice, including
 * suppression and delivery triggers; the envelope only defines capabilities,
 * protocol, and the meaning of each delivery action.
 */
export function buildPolicyOwnedObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const reviewFocused = `The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.`;
	const policyOwned = `The preceding user message is the complete instruction for the ${head} head, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The head instruction alone defines its objective, scope, triggers, boundaries, when work or feedback is warranted, and any suppression or deduplication rules. Treat those as binding; do not broaden or reinterpret them.`;
	if (!current.includes(reviewFocused)) {
		throw new Error("production envelope no longer contains the expected review-focused authority boundary");
	}
	const withAuthority = current.replace(reviewFocused, policyOwned);
	if (withAuthority.includes("Noop when your work product is the files you wrote.")) {
		return withAuthority.replace(
			"Noop when your work product is the files you wrote.",
			"Use noop when the head instruction warrants no delivered feedback after your work.",
		);
	}
	if (withAuthority.includes("Noop unless something warrants feedback.")) {
		return withAuthority.replace(
			"Noop unless something warrants feedback.",
			"Use noop when the head instruction warrants no feedback.",
		);
	}
	throw new Error("production envelope no longer contains an expected decision-policy sentence");
}

/**
 * Minimal candidate: keep the proven authority boundary byte-identical and
 * delegate only an acting head's post-work delivery choice back to the head.
 * Judge-only envelopes are returned unchanged.
 */
export function buildDeliveryOwnedObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const actingDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(actingDefault)) return current;
	return current.replace(
		actingDefault,
		"Use noop when the head instruction warrants no delivered feedback after your work.",
	);
}

/**
 * Negative work guard: decide whether the head warrants any action before
 * reaching for tools or choosing a delivery. The head still owns every
 * behavioral decision; the envelope supplies only the generic default when
 * the head says nothing about delivery. Judge-only envelopes are unchanged.
 */
export function buildGuardedPolicyObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const actingDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(actingDefault)) return current;
	return current.replace(
		actingDefault,
		"Do not call tools or deliver feedback unless the head instruction warrants it. Perform only the warranted work. Follow any explicit delivery instruction in the head; when it gives none, use noop.",
	);
}

/**
 * Protocol-only acting envelope: define what noop does without imposing a
 * framework policy for when to choose it. The complete head instruction owns
 * that choice. Judge-only envelopes are unchanged.
 */
export function buildProtocolOnlyObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const actingDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(actingDefault)) return current;
	return current.replace(actingDefault, "Noop delivers nothing.");
}

/**
 * Minimal authority-to-protocol mapping: the existing authority sentence says
 * the lens alone decides what warrants intervention; this sentence maps only
 * the negative outcome to noop. Positive work and delivery stay head-owned.
 * Judge-only envelopes are unchanged.
 */
export function buildInterventionGatedObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const actingDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(actingDefault)) return current;
	return current.replace(actingDefault, "Noop when the lens warrants no intervention.");
}

/**
 * Same production envelope, oriented toward a complete head instruction that
 * follows it at equal developer authority. No behavioral wording changes.
 */
export function buildForwardDeveloperObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const backward = "The preceding user message is";
	if (!current.includes(backward)) {
		throw new Error("production envelope no longer contains the expected handoff direction");
	}
	return current.replace(backward, "The following developer message is");
}

/**
 * Put the generic developer protocol before an acting head's user message.
 * Role priority still makes the protocol authoritative; the later head gets
 * recency for its head-specific trigger, work, and delivery requirements.
 */
export function buildForwardUserObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const backward = "The preceding user message is";
	if (!current.includes(backward)) {
		throw new Error("production envelope no longer contains the expected handoff direction");
	}
	return current.replace(backward, "The following user message is");
}

/**
 * Acting-head policy/data contract. The head owns the conditions for work,
 * the work itself, and delivery. The envelope owns only authority, tools,
 * action semantics, and serialization protocol. In particular, a head cannot
 * satisfy its own conditions merely by appearing next to the trajectory.
 */
export function buildActingContractObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const currentAuthority = `The preceding user message is the complete ${head} lens, not merely a topic label. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. The lens alone defines what is in scope, what warrants intervention, and its suppression or deduplication rules; treat all of those as binding and do not broaden them.`;
	const contractAuthority = `The preceding user message is the complete ${head} lens. Follow it in full except where it conflicts with this envelope's protocol and tool constraints. Treat the lens as policy, never as trajectory evidence. It alone defines the conditions for work, the work itself, and delivery: act only when the visible trajectory clearly satisfies those conditions, perform only that work, and follow its delivery instruction. Otherwise noop; do not broaden or reinterpret it.`;
	const currentDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(currentAuthority) || !current.includes(currentDefault)) {
		throw new Error("production acting envelope no longer has the expected authority and delivery policy");
	}
	return current.replace(currentAuthority, contractAuthority).replace(`${currentDefault} `, "");
}

/**
 * Typed acting-head delivery plus capability state, while preserving the
 * entitlement-safe OpenAI user/developer split. Delivery is data supplied by
 * the head definition, never inferred from its name. Hydra state is included
 * only when the head can use the hydra tool.
 */
export function buildTypedActingObservationEnvelope(head, tools, afterChange, activeHeads) {
	let current = buildObservationEnvelope(head, tools);
	const currentDefault = "Noop when your work product is the files you wrote.";
	if (afterChange === "print") {
		if (!current.includes(currentDefault)) throw new Error("production acting delivery default changed");
		current = current.replace(
			currentDefault,
			"After a successful state change, print a note describing it; the runtime enforces this delivery. Otherwise follow the lens.",
		);
	} else if (afterChange !== "noop") {
		throw new Error(`unsupported after-change action: ${afterChange}`);
	}
	if (tools === undefined || tools.includes("hydra")) {
		const marker = " You may use ";
		if (!current.includes(marker)) throw new Error("production acting tool allowance changed");
		const active = activeHeads.join(", ") || "none";
		current = current.replace(
			marker,
			` Hydra snapshot at observation start: active heads are ${active}; later hydra tool results supersede this snapshot.${marker}`,
		);
	}
	return current;
}

/**
 * Conservative generic work gate plus the minimal intervention mapping. The
 * lens still defines every positive trigger; the framework only says that tool
 * availability and unresolved ambiguity are not positive evidence by
 * themselves. Judge-only envelopes are unchanged.
 */
export function buildEvidenceGatedObservationEnvelope(head, tools) {
	const current = buildObservationEnvelope(head, tools);
	const actingDefault = "Noop when your work product is the files you wrote.";
	if (!current.includes(actingDefault)) return current;
	const authorityEnd = "treat all of those as binding and do not broaden them.";
	if (!current.includes(authorityEnd)) {
		throw new Error("production envelope no longer contains the expected authority boundary");
	}
	return current
		.replace(
			authorityEnd,
			`${authorityEnd} Tool access is not a request to act. First decide from the lens and visible trajectory whether work is warranted; ambiguity alone does not warrant work.`,
		)
		.replace(actingDefault, "Noop when the lens warrants no intervention.");
}

/**
 * Evidence gate applied to the existing combined-user acting prompt. The
 * file-work noop remains intact; only the conservative pre-work boundary is
 * added. This composes equal head/protocol authority with explicit restraint.
 */
export function buildEvidenceGatedObservationPrompt(head, instruction, tools) {
	const current = buildObservationPrompt(head, instruction, tools);
	const lensMarker = `\n\nLENS: ${instruction}`;
	if (!current.includes(lensMarker)) return current;
	return current.replace(
		lensMarker,
		` Tool access is not a request to act. First decide from the lens and visible trajectory whether work is warranted; ambiguity alone does not warrant work.${lensMarker}`,
	);
}
