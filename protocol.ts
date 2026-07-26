import { StringEnum, Type } from "@earendil-works/pi-ai";

/**
 * One schema is advertised to the driver and every observer for cache parity.
 *
 * Branch invariants are enforced by validateHydraToolParams rather than JSON
 * Schema anyOf. Anthropic models were measured emitting an empty argument
 * object on the first call against the equivalent anyOf schema, then fixing it
 * after a validation turn. The flat representation keeps the same public API
 * and enforcement while avoiding that provider failure mode.
 */
export const hydraToolParameters = Type.Object(
	{
		action: StringEnum(["manage_heads", "complete_observation"] as const, {
			description: "Manage active heads or return an observer's final decision",
		}),
		operation: Type.Optional(StringEnum(["add", "remove"] as const, { description: "manage_heads only" })),
		head: Type.Optional(Type.String({ minLength: 1, description: "manage_heads only: the head name" })),
		delivery: Type.Optional(
			StringEnum(["none", "print", "queue", "steer", "interrupt"] as const, {
				description:
					"complete_observation only: none=no feedback; print=user only; queue=agent later; steer=agent now; interrupt=emergency abort",
			}),
		),
		message: Type.String({
			maxLength: 1000,
			description:
				'For manage_heads, concisely explain the change. For complete_observation, exactly "" with none; otherwise concise feedback, ideally <=240 characters.',
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
	delivery: "none" | "print" | "queue" | "steer" | "interrupt";
	message: string;
}

export type HydraToolParams = ManageHeadsParams | CompleteObservationParams;

export function validateHydraToolParams(value: {
	action: "manage_heads" | "complete_observation";
	operation?: "add" | "remove";
	head?: string;
	delivery?: "none" | "print" | "queue" | "steer" | "interrupt";
	message: string;
}): HydraToolParams {
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
		"Manage hydra or complete a head observation. `manage_heads` adds or",
		"removes one active head idempotently; its message explains why the",
		"change fits the trajectory. A successful observer-originated change",
		"automatically prints that explanation. `complete_observation` is reserved",
		"for an active head. Keep feedback concise, ideally under 240 characters.",
		"Use `none` for no feedback;",
		"`print` only when the",
		"agent need not act; `queue` when agent action can wait; `steer` when the",
		"agent must correct current work before continuing; and `interrupt` only",
		"for an emergency that must abort the run. Heads are markdown files in",
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
