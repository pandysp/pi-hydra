import { StringEnum, Type } from "@earendil-works/pi-ai";
import { HEAD_LIFETIMES, isValidHeadName, OBSERVATION_DELIVERIES, OBSERVER_DELIVERY_GUIDANCE } from "./utils.ts";
import type { HeadLifetimeName, ObservationDelivery } from "./utils.ts";

/**
 * The driver and every head are shown the same tool description. They have to
 * be, or the replayed request stops matching and the cache saving is lost.
 *
 * The rules about which fields go together are checked in code rather than
 * expressed in the schema. Written the schema way, Anthropic models were
 * measured calling the tool with no arguments at all on the first try, then
 * correcting themselves after being told off. Flattening it keeps the same
 * rules and the same public shape without provoking that.
 */
export const hydraToolParameters = Type.Object(
	{
		action: StringEnum(["manage_heads", "complete_observation"] as const, {
			description: "Add or remove heads, or finish a head's check",
		}),
		operation: Type.Optional(StringEnum(["add", "remove"] as const, { description: "manage_heads only" })),
		head: Type.Optional(
			Type.String({
				minLength: 1,
				description: "manage_heads only: a head file's name, or a new name for a head without a file",
			}),
		),
		lifetime: Type.Optional(
			StringEnum(HEAD_LIFETIMES, {
				description:
					'manage_heads add only. "ongoing" (default): the head checks after each response of the main assistant until it is removed or its ends_when is met. "once": one check, which starts with your next response and sees the conversation up to this call; it runs in the background, then the head is gone and nothing is saved. Its feedback reaches you later, like any head\'s.',
			}),
		),
		ends_when: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					'manage_heads add only, not with lifetime "once": a condition after which the head is no longer needed, e.g. "the refactor is committed". The head judges it at every check from the conversation, or checks it with its tools, and ends itself once it is met.',
			}),
		),
		instructions: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					'manage_heads add only: instructions for a head without a file; no file is written. Needs lifetime "once" or ends_when. Omit to use the head file named by head.',
			}),
		),
		tools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"manage_heads add with instructions only: tools that head may use for its work. Omit for all tools; [] for none (it only judges). Every head can always report back.",
			}),
		),
		delivery: Type.Optional(
			StringEnum(OBSERVATION_DELIVERIES, {
				description:
					"complete_observation only: none=nothing to report; steer=message to the main assistant without stopping it",
			}),
		),
		done: Type.Optional(
			Type.Boolean({
				description:
					"complete_observation only, for a head added with ends_when: true when that condition is met; the head ends after this report.",
			}),
		),
		message: Type.String({
			maxLength: 1000,
			description:
				'For manage_heads, briefly explain the change. For complete_observation, use "" with none; otherwise give short feedback, ideally under 240 characters.',
		}),
	},
	{ additionalProperties: false },
);

/** Where an added head's instructions come from: its file, or the call itself. */
export type HeadSource = { kind: "file" } | { kind: "inline"; instructions: string; tools: string[] | undefined };

/**
 * How long an added head lives. `once` cannot have an end condition, so the
 * type has no place to put one.
 */
export type HeadLifetime = { kind: "ongoing"; endsWhen: string | undefined } | { kind: "once" };

export interface AddHeadParams {
	action: "manage_heads";
	operation: "add";
	head: string;
	message: string;
	source: HeadSource;
	lifetime: HeadLifetime;
}

export interface RemoveHeadParams {
	action: "manage_heads";
	operation: "remove";
	head: string;
	message: string;
}

export type ManageHeadsParams = AddHeadParams | RemoveHeadParams;

export interface CompleteObservationParams {
	action: "complete_observation";
	delivery: ObservationDelivery;
	message: string;
	/** The head's end condition is met. Only heads added with ends_when act on it. */
	done: boolean;
}

export type HydraToolParams = ManageHeadsParams | CompleteObservationParams;

/**
 * Reads a head's decision back out of a tool call without running anything.
 * The call is only accepted if it was the only one in the turn and already
 * passes the same checks a real call would.
 */
export function completionFromHydraToolCalls(content: readonly unknown[]): CompleteObservationParams | null {
	const calls = content.filter(
		(item): item is { type: "toolCall"; name: string; arguments: RawHydraToolParams } =>
			typeof item === "object" && item !== null && (item as { type?: unknown }).type === "toolCall",
	);
	if (calls.length !== 1 || calls[0].name !== "hydra") return null;
	try {
		const params = validateHydraToolParams(calls[0].arguments);
		return params.action === "complete_observation" ? params : null;
	} catch {
		return null;
	}
}

/** What a hydra tool call looks like before anything has been checked. */
export interface RawHydraToolParams {
	action: "manage_heads" | "complete_observation";
	operation?: "add" | "remove";
	head?: string;
	lifetime?: HeadLifetimeName;
	ends_when?: string;
	instructions?: string;
	tools?: string[];
	delivery?: ObservationDelivery;
	done?: boolean;
	message: string;
}

function rejectFields(value: RawHydraToolParams, fields: (keyof RawHydraToolParams)[], context: string) {
	const present = fields.filter((field) => value[field] !== undefined);
	if (present.length > 0) {
		throw new Error(`${context} does not accept ${present.join(", ")}`);
	}
}

export function validateHydraToolParams(value: RawHydraToolParams): HydraToolParams {
	if (value.action === "manage_heads") {
		if (value.operation === undefined || value.head === undefined) {
			throw new Error("manage_heads requires operation and head");
		}
		rejectFields(value, ["delivery", "done"], "manage_heads");
		if (value.operation === "remove") {
			rejectFields(value, ["lifetime", "ends_when", "instructions", "tools"], "manage_heads remove");
			return { action: value.action, operation: value.operation, head: value.head, message: value.message };
		}
		return {
			action: value.action,
			operation: value.operation,
			head: value.head,
			message: value.message,
			source: headSource(value),
			lifetime: headLifetime(value),
		};
	}
	if (value.delivery === undefined) {
		throw new Error("complete_observation requires delivery");
	}
	if (!(OBSERVATION_DELIVERIES as readonly string[]).includes(value.delivery)) {
		throw new Error(`complete_observation delivery must be one of ${OBSERVATION_DELIVERIES.join(", ")}`);
	}
	rejectFields(value, ["operation", "head", "lifetime", "ends_when", "instructions", "tools"], "complete_observation");
	if (value.done !== undefined && typeof value.done !== "boolean") {
		throw new Error("complete_observation done must be true or false");
	}
	return {
		action: value.action,
		delivery: value.delivery,
		message: value.message,
		done: value.done === true,
	};
}

function headSource(value: RawHydraToolParams): HeadSource {
	if (value.instructions === undefined) {
		if (value.tools !== undefined) {
			throw new Error("tools is only for a head without a file, described by instructions; a head file sets its own tools");
		}
		return { kind: "file" };
	}
	const instructions = value.instructions.trim();
	if (instructions.length === 0) {
		throw new Error("instructions must not be empty");
	}
	if (!isValidHeadName(value.head?.trim() ?? "")) {
		throw new Error(`"${value.head}" is not a valid name for a head without a file: use lowercase letters, digits and dashes`);
	}
	if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string"))) {
		throw new Error("tools must be a list of tool names");
	}
	return { kind: "inline", instructions, tools: value.tools?.map((tool) => tool.trim()) };
}

function headLifetime(value: RawHydraToolParams): HeadLifetime {
	const lifetime = value.lifetime ?? "ongoing";
	if (!(HEAD_LIFETIMES as readonly string[]).includes(lifetime)) {
		throw new Error(`lifetime must be one of ${HEAD_LIFETIMES.join(", ")}`);
	}
	const endsWhen = value.ends_when?.trim();
	if (value.ends_when !== undefined && !endsWhen) {
		throw new Error("ends_when must not be empty");
	}
	if (lifetime === "once") {
		if (endsWhen !== undefined) {
			throw new Error('lifetime "once" ends after one check and cannot take ends_when');
		}
		return { kind: "once" };
	}
	if (value.instructions !== undefined && endsWhen === undefined) {
		throw new Error('a head without a file needs an end: lifetime "once" or an ends_when');
	}
	return { kind: "ongoing", endsWhen };
}

export function hydraToolDescription(userHeadDir: string): string {
	return [
		"Manage heads or finish a head's check. A head is a helper model that",
		"sees this conversation and checks or works alongside the main",
		"assistant. `manage_heads` adds or removes one head; explain every",
		"change in `message`. An added head is either a head file (name it in",
		"`head`) or a head without a file, described by `instructions`.",
		"`lifetime` and `ends_when` work for both and decide how long the head",
		'lives; a head without a file must have one of them: lifetime "once" or',
		'an `ends_when`. Use "once" for a job (check or do something, then',
		"report) and `ends_when` for watching over several steps. Write a head",
		"file only for a head worth reusing in later sessions. Adding an active",
		"head or removing an inactive one changes nothing; adding an active head",
		'with "once" or `ends_when` is an error. When a head changes',
		"the active set, Hydra steers that explanation to the main assistant as",
		"the head. Only a head, during its check, can use",
		"`complete_observation`. Keep feedback short, ideally under 240",
		"characters. Use `none` when there is nothing to report.",
		OBSERVER_DELIVERY_GUIDANCE,
		"Heads are Markdown files in",
		`${userHeadDir} (user) and .pi/hydra (project).`,
		"The file header must have `name:` and `description:`. Omit `tools:` to",
		"allow all tools, use `[]` for no tools, or list allowed tool names",
		"separated by commas. `autostart: true` activates the head in new",
		"sessions. No other header keys are allowed. The body gives the head's",
		"instructions: what to check, when to act, what work to do, and how to",
		"finish and report. Hydra rereads the files on every call.",
	].join(" ");
}

export function isTerminalHydraAction(value: unknown, observingHead: string): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const params = value as { action?: unknown; operation?: unknown; head?: unknown };
	return (
		params.action === "complete_observation" ||
		(params.action === "manage_heads" &&
			params.operation === "remove" &&
			typeof params.head === "string" &&
			params.head.trim() === observingHead)
	);
}
