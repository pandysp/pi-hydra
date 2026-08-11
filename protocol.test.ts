import { describe, expect, it } from "vitest";
import {
	completionFromHydraToolCalls,
	hydraToolDescription,
	hydraToolParameters,
	isTerminalHydraAction,
	validateHydraToolParams,
} from "./protocol";

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
		expect(schema.properties?.delivery?.enum).toEqual(["none", "print", "steer", "interrupt"]);
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
		// Queueing is kept working but no longer offered, so old sessions and
		// internal callers still pass validation.
		expect(
			validateHydraToolParams({
				action: "complete_observation",
				delivery: "queue",
				message: "legacy follow-up",
			}),
		).toEqual({ action: "complete_observation", delivery: "queue", message: "legacy follow-up" });
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
		).toThrow("does not accept operation or head");
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
		expect(description).toContain("print` only when the agent need not act");
		expect(description).toContain("steer` is the normal and only way to reach the agent");
		expect(description).not.toContain("queue");
	});
});
