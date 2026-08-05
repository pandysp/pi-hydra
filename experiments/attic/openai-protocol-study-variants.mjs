/** Exact, pre-spend OpenAI variants for OPENAI-PROTOCOL-STUDY-SPEC.md. */

import { createHash } from "node:crypto";
import { buildEnumeratedJudgeObservationEnvelope } from "../../utils.ts";
import { GOLDEN_HEADS } from "../delivery-context-golden-cases.mjs";

export const STUDY_HEAD = "quality";
export const STUDY_LENS = GOLDEN_HEADS[STUDY_HEAD];
export const EMPTY_DELIVERY_CONTEXT = Object.freeze({ lastByThisHead: null, pending: [] });

const CONTROL_SHAPE =
	'{"findings":[{"action":"print|steer|interrupt","reason":"≤120 chars","message":"≤240 chars"}]}';
const TERSE_SHAPE =
	'{"findings":[{"action":"print|steer|interrupt","reason":"≤80 chars","message":"≤120 chars"}]}';
const ENUMERATION_SENTENCE =
	"List every finding the lens surfaces, each as its own entry with its own action; empty findings array if none. Do not rank them or pick one.";
const TERSE_DISCIPLINE =
	"Keep each reason and message to one short sentence. State the concrete defect and consequence; omit preambles, code restatement, hedging, and prose transitions.";
const INTERRUPT_SENTENCE = "Interrupt only for emergencies that must stop the line. ";

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first === -1) throw new Error(`${label}: anchor not found`);
	if (text.indexOf(find, first + find.length) !== -1) throw new Error(`${label}: anchor is ambiguous`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

export const CONTROL_ENVELOPE = buildEnumeratedJudgeObservationEnvelope(STUDY_HEAD, EMPTY_DELIVERY_CONTEXT);

export function terseEnvelope(envelope) {
	return replaceOnce(
		replaceOnce(envelope, CONTROL_SHAPE, TERSE_SHAPE, "terse/shape"),
		ENUMERATION_SENTENCE,
		`${ENUMERATION_SENTENCE} ${TERSE_DISCIPLINE}`,
		"terse/discipline",
	);
}

export function noInterruptEnvelope(envelope) {
	return replaceOnce(
		replaceOnce(envelope, "|interrupt", "", "no-interrupt/shape"),
		INTERRUPT_SENTENCE,
		"",
		"no-interrupt/routing",
	);
}

export const TERSE_ENVELOPE = terseEnvelope(CONTROL_ENVELOPE);
export const NO_INTERRUPT_ENVELOPE = noInterruptEnvelope(CONTROL_ENVELOPE);
export const TERSE_NO_INTERRUPT_ENVELOPE = noInterruptEnvelope(TERSE_ENVELOPE);

const hash = (text) => createHash("sha256").update(text).digest("hex");

export const OPENAI_PROTOCOL_STUDY_ARMS = Object.freeze({
	"ENUM-SO2": Object.freeze({
		id: "ENUM-SO2",
		envelope: CONTROL_ENVELOPE,
		actions: Object.freeze(["print", "steer", "interrupt"]),
		reasonCap: 120,
		messageCap: 240,
	}),
	"ENUM-SO2-TERSE": Object.freeze({
		id: "ENUM-SO2-TERSE",
		envelope: TERSE_ENVELOPE,
		actions: Object.freeze(["print", "steer", "interrupt"]),
		reasonCap: 80,
		messageCap: 120,
	}),
	"ENUM-SO2-NOINT": Object.freeze({
		id: "ENUM-SO2-NOINT",
		envelope: NO_INTERRUPT_ENVELOPE,
		actions: Object.freeze(["print", "steer"]),
		reasonCap: 120,
		messageCap: 240,
	}),
	"ENUM-SO2-TERSE-NOINT": Object.freeze({
		id: "ENUM-SO2-TERSE-NOINT",
		envelope: TERSE_NO_INTERRUPT_ENVELOPE,
		actions: Object.freeze(["print", "steer"]),
		reasonCap: 80,
		messageCap: 120,
	}),
});

export const OPENAI_PROTOCOL_STUDY_ARM_HASHES = Object.freeze(
	Object.fromEntries(
		Object.entries(OPENAI_PROTOCOL_STUDY_ARMS).map(([id, arm]) => [id, hash(`${STUDY_LENS}\n${arm.envelope}`)]),
	),
);

export function parseStudyResponse(armId, text) {
	const arm = OPENAI_PROTOCOL_STUDY_ARMS[armId];
	if (!arm) throw new Error(`unknown study arm: ${armId}`);
	let value;
	try {
		const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
		value = JSON.parse((fenced ? fenced[1] : text).trim());
	} catch {
		return { findings: null, error: "completion must be one JSON object", capsValid: false };
	}
	if (!value || typeof value !== "object" || !Array.isArray(value.findings)) {
		return { findings: null, error: "completion requires a findings array", capsValid: false };
	}
	const findings = [];
	for (const [index, item] of value.findings.entries()) {
		if (!item || typeof item !== "object") {
			return { findings: null, error: `finding ${index} must be an object`, capsValid: false };
		}
		if (!arm.actions.includes(item.action)) {
			return { findings: null, error: `finding ${index} has invalid action`, capsValid: false };
		}
		if (typeof item.reason !== "string" || item.reason.trim() === "") {
			return { findings: null, error: `finding ${index} requires reason`, capsValid: false };
		}
		if (typeof item.message !== "string" || item.message.trim() === "") {
			return { findings: null, error: `finding ${index} requires message`, capsValid: false };
		}
		findings.push({ action: item.action, reason: item.reason, message: item.message });
	}
	return {
		findings,
		error: null,
		capsValid: findings.every(
			(finding) => finding.reason.length <= arm.reasonCap && finding.message.length <= arm.messageCap,
		),
	};
}

for (const [id, arm] of Object.entries(OPENAI_PROTOCOL_STUDY_ARMS)) {
	if (/queue/i.test(arm.envelope)) throw new Error(`${id}: queue leaked into the model-facing contract`);
	if (id.includes("NOINT") && /interrupt/i.test(arm.envelope)) {
		throw new Error(`${id}: interrupt survived the no-interrupt edit`);
	}
	if (!id.includes("NOINT") && !/interrupt/i.test(arm.envelope)) {
		throw new Error(`${id}: control interrupt route disappeared`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	for (const [id, arm] of Object.entries(OPENAI_PROTOCOL_STUDY_ARMS)) {
		process.stdout.write(`${id}\t${OPENAI_PROTOCOL_STUDY_ARM_HASHES[id]}\t${arm.envelope.length} chars\n`);
	}
}
