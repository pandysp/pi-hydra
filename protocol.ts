import { StringEnum, Type } from "@earendil-works/pi-ai";
import { OBSERVER_DELIVERY_GUIDANCE } from "./utils";

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
			description: "Add or remove active heads, or finish a head's check",
		}),
		operation: Type.Optional(StringEnum(["add", "remove"] as const, { description: "manage_heads only" })),
		head: Type.Optional(Type.String({ minLength: 1, description: "manage_heads only: the head name" })),
		delivery: Type.Optional(
			StringEnum(["none", "print", "steer", "interrupt"] as const, {
				description:
					"complete_observation only: none=nothing to report; print=user-only note; steer=message to the main assistant without stopping it; interrupt=stop the run for an emergency",
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

export interface ManageHeadsParams {
	action: "manage_heads";
	operation: "add" | "remove";
	head: string;
	message: string;
}

export interface CompleteObservationParams {
	action: "complete_observation";
	/** Queueing still works, for old sessions, but heads are no longer offered it. */
	delivery: "none" | "print" | "queue" | "steer" | "interrupt";
	message: string;
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
	delivery?: "none" | "print" | "queue" | "steer" | "interrupt";
	message: string;
}

export function validateHydraToolParams(value: RawHydraToolParams): HydraToolParams {
	if (value.action === "manage_heads") {
		if (value.operation === undefined || value.head === undefined) {
			throw new Error("manage_heads requires operation and head");
		}
		if (value.delivery !== undefined) {
			throw new Error("manage_heads does not accept delivery");
		}
		return {
			action: value.action,
			operation: value.operation,
			head: value.head,
			message: value.message,
		};
	}
	if (value.delivery === undefined) {
		throw new Error("complete_observation requires delivery");
	}
	if (value.operation !== undefined || value.head !== undefined) {
		throw new Error("complete_observation does not accept operation or head");
	}
	return {
		action: value.action,
		delivery: value.delivery,
		message: value.message,
	};
}

export function hydraToolDescription(userHeadDir: string): string {
	return [
		"Manage heads or finish a head's check. `manage_heads` adds or removes",
		"one active head; adding an active head or removing an inactive one",
		"changes nothing. Explain why the change helps with the current task.",
		"When a head changes the active set, Hydra automatically shows that",
		"explanation to the user. Only an active head can use",
		"`complete_observation`. Keep feedback short, ideally under 240",
		"characters. Use `none` when there is nothing to report.",
		OBSERVER_DELIVERY_GUIDANCE,
		"Heads are Markdown files in",
		`${userHeadDir} (user) and .pi/hydra (project).`,
		"The file header must have `name:` and `description:`. Omit `tools:` to",
		"allow all tools, use `[]` for no tools, or list allowed tool names",
		"separated by commas. `autostart: true` activates the head in new",
		"sessions. No other header keys are allowed. The body gives the head's",
		"instructions: what to check, when to",
		"act, what work to do, and how to finish and report. To create or change",
		"a head, write its file, then add it. Hydra rereads the files on every",
		"call. Change the active heads when the task needs different help.",
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
