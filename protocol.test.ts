import { describe, expect, it } from "vitest";
import {
	completionFromHydraToolCalls,
	hydraToolDescription,
	hydraToolParameters,
	isTerminalHydraAction,
	validateHydraToolParams,
} from "./protocol.ts";

describe("hydra tool protocol", () => {
	it("accepts only a sole valid typed completion from cached tool calls", () => {
		expect(
			completionFromHydraToolCalls([
				{ type: "thinking", thinking: "done" },
				{
					type: "toolCall",
					name: "hydra",
					arguments: { action: "complete_observation", delivery: "steer", message: "Fix it." },
				},
			]),
		).toEqual({ action: "complete_observation", delivery: "steer", message: "Fix it." });
		expect(
			completionFromHydraToolCalls([{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }]),
		).toBeNull();
		expect(
			completionFromHydraToolCalls([
				{
					type: "toolCall",
					name: "hydra",
					arguments: { action: "complete_observation", delivery: "none", message: "" },
				},
				{ type: "toolCall", name: "bash", arguments: { command: "pwd" } },
			]),
		).toBeNull();
	});

	it("returns null for a management call, invalid arguments, or no tool calls", () => {
		expect(
			completionFromHydraToolCalls([
				{
					type: "toolCall",
					name: "hydra",
					arguments: { action: "manage_heads", operation: "add", head: "docs", message: "phase change" },
				},
			]),
		).toBeNull();
		expect(
			completionFromHydraToolCalls([
				{ type: "toolCall", name: "hydra", arguments: { action: "complete_observation", message: "missing delivery" } },
			]),
		).toBeNull();
		expect(completionFromHydraToolCalls([])).toBeNull();
	});

	it("advertises one flat schema with the two public actions", () => {
		const schema = hydraToolParameters as {
			required?: string[];
			properties?: { action?: { enum?: string[] }; delivery?: { enum?: string[] } };
		};
		expect(schema.required).toEqual(["action", "message"]);
		expect(schema.properties?.action?.enum).toEqual(["manage_heads", "complete_observation"]);
		expect(schema.properties?.delivery?.enum).toEqual(["none", "steer"]);
	});

	it("enforces action-specific fields at runtime", () => {
		expect(
			validateHydraToolParams({
				action: "manage_heads",
				operation: "add",
				head: "security",
				message: "implementation started",
			}),
		).toMatchObject({ action: "manage_heads", operation: "add", head: "security" });
		expect(
			validateHydraToolParams({
				action: "complete_observation",
				delivery: "none",
				message: "",
			}),
		).toEqual({ action: "complete_observation", delivery: "none", message: "" });
		// Hydra's own note route is not a head's choice.
		expect(() =>
			validateHydraToolParams({ action: "complete_observation", delivery: "note" as never, message: "follow-up" }),
		).toThrow("delivery must be one of none, steer");
		expect(() => validateHydraToolParams({ action: "manage_heads", message: "missing fields" })).toThrow(
			"requires operation and head",
		);
		expect(() =>
			validateHydraToolParams({
				action: "complete_observation",
				operation: "remove",
				head: "quality",
				delivery: "none",
				message: "",
			}),
		).toThrow("does not accept operation, head");
	});

	it("reads an added head's source and lifetime into one exact shape", () => {
		const add = (fields: Record<string, unknown>) =>
			validateHydraToolParams({ action: "manage_heads", operation: "add", head: "cache-check", message: "why", ...fields } as never);
		expect(add({})).toMatchObject({ source: { kind: "file" }, lifetime: { kind: "ongoing", endsWhen: undefined } });
		expect(add({ lifetime: "once" })).toMatchObject({ source: { kind: "file" }, lifetime: { kind: "once" } });
		expect(add({ ends_when: " the auth PR is merged " })).toMatchObject({ lifetime: { kind: "ongoing", endsWhen: "the auth PR is merged" } });
		expect(add({ lifetime: "once", instructions: "Check the key.", tools: ["read"] })).toMatchObject({
			source: { kind: "inline", instructions: "Check the key.", tools: ["read"] },
			lifetime: { kind: "once" },
		});
		expect(add({ instructions: "Review each step.", ends_when: "the refactor is committed" })).toMatchObject({
			source: { kind: "inline", tools: undefined },
			lifetime: { kind: "ongoing", endsWhen: "the refactor is committed" },
		});
	});

	it.each([
		[{ instructions: "Review." }, "a head without a file needs an end"],
		[{ lifetime: "ongoing", instructions: "Review." }, "a head without a file needs an end"],
		[{ lifetime: "once", ends_when: "x" }, 'lifetime "once" ends after one check and cannot take ends_when'],
		[{ lifetime: "once", tools: ["read"] }, "tools is only for a head without a file"],
		[{ lifetime: "forever" }, "lifetime must be one of ongoing, once"],
		[{ lifetime: "once", instructions: "   " }, "instructions must not be empty"],
		[{ ends_when: "  " }, "ends_when must not be empty"],
		[{ lifetime: "once", instructions: "x", head: "Bad Name" }, "is not a valid name for a head without a file"],
		[{ lifetime: "once", instructions: "x", head: "none" }, "is not a valid name for a head without a file"],
		[{ done: true }, "manage_heads does not accept done"],
	])("rejects an invalid add: %j", (fields, error) => {
		expect(() =>
			validateHydraToolParams({ action: "manage_heads", operation: "add", head: "cache-check", message: "why", ...fields } as never),
		).toThrow(error);
	});

	it("keeps remove and complete_observation free of the add fields", () => {
		for (const field of [{ lifetime: "once" }, { ends_when: "x" }, { instructions: "x" }, { tools: [] }]) {
			expect(() => validateHydraToolParams({ action: "manage_heads", operation: "remove", head: "q", message: "m", ...field } as never)).toThrow(
				"manage_heads remove does not accept",
			);
			expect(() => validateHydraToolParams({ action: "complete_observation", delivery: "none", message: "", ...field } as never)).toThrow(
				"complete_observation does not accept",
			);
		}
		expect(validateHydraToolParams({ action: "complete_observation", delivery: "none", message: "", done: true })).toMatchObject({ done: true });
		expect(() => validateHydraToolParams({ action: "complete_observation", delivery: "none", message: "", done: "yes" } as never)).toThrow(
			"done must be true or false",
		);
	});

	it("rejects deprecated print in live and cached completions", () => {
		expect(() =>
			// @ts-expect-error print is retained internally, not in the public delivery type.
			validateHydraToolParams({ action: "complete_observation", delivery: "print", message: "user only" }),
		).toThrow("delivery must be one of none, steer");
		expect(completionFromHydraToolCalls([
			{ type: "toolCall", name: "hydra", arguments: { action: "complete_observation", delivery: "print", message: "user only" } },
		])).toBeNull();
	});

	it("rejects the remaining cross-branch field mistakes", () => {
		expect(() =>
			validateHydraToolParams({
				action: "manage_heads",
				operation: "remove",
				head: "docs",
				delivery: "none",
				message: "m",
			}),
		).toThrow("does not accept delivery");
		expect(() => validateHydraToolParams({ action: "complete_observation", message: "m" })).toThrow(
			"requires delivery",
		);
	});

	it("treats completion and only successful-intent self-removal as terminal shapes", () => {
		expect(isTerminalHydraAction({ action: "complete_observation", delivery: "none", message: "" }, "foreman")).toBe(true);
		expect(
			isTerminalHydraAction(
				{ action: "manage_heads", operation: "remove", head: " foreman ", message: "staffing complete" },
				"foreman",
			),
		).toBe(true);
		expect(
			isTerminalHydraAction(
				{ action: "manage_heads", operation: "remove", head: "quality", message: "phase ended" },
				"foreman",
			),
		).toBe(false);
		expect(isTerminalHydraAction({ action: "remove", head: "foreman" }, "foreman")).toBe(false);
		expect(
			isTerminalHydraAction({ action: "manage_heads", operation: "add", head: "foreman", message: "m" }, "foreman"),
		).toBe(false);
		expect(isTerminalHydraAction(null, "foreman")).toBe(false);
		expect(isTerminalHydraAction("complete_observation", "foreman")).toBe(false);
	});

	it("defines delivery by who must act and when", () => {
		const description = hydraToolDescription("/heads");
		expect(description).not.toContain('"print"');
		expect(description).toContain('Use "steer" when the main assistant needs the feedback, even if it can wait');
		expect(description).toContain("before its next model request");
		expect(description).not.toContain('"note"');
	});
});
