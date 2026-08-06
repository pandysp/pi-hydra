import { describe, expect, it } from "vitest";
import { completionFromHydraToolCalls, isTerminalHydraAction, validateHydraToolParams } from "./protocol";

describe("validateHydraToolParams", () => {
	it("accepts a manage_heads call", () => {
		expect(
			validateHydraToolParams({ action: "manage_heads", operation: "add", head: "quality", message: "covers correctness" }),
		).toEqual({ action: "manage_heads", operation: "add", head: "quality", message: "covers correctness" });
	});

	it("rejects manage_heads without operation or head", () => {
		expect(() => validateHydraToolParams({ action: "manage_heads", head: "quality", message: "m" })).toThrow(
			"requires operation and head",
		);
		expect(() => validateHydraToolParams({ action: "manage_heads", operation: "add", message: "m" })).toThrow(
			"requires operation and head",
		);
	});

	it("rejects manage_heads carrying a delivery", () => {
		expect(() =>
			validateHydraToolParams({ action: "manage_heads", operation: "remove", head: "docs", delivery: "none", message: "m" }),
		).toThrow("does not accept delivery");
	});

	it("accepts a complete_observation call, including the unadvertised queue", () => {
		expect(validateHydraToolParams({ action: "complete_observation", delivery: "steer", message: "fix the redirect" })).toEqual({
			action: "complete_observation",
			delivery: "steer",
			message: "fix the redirect",
		});
		expect(validateHydraToolParams({ action: "complete_observation", delivery: "queue", message: "waitable" })).toEqual({
			action: "complete_observation",
			delivery: "queue",
			message: "waitable",
		});
	});

	it("rejects complete_observation without delivery", () => {
		expect(() => validateHydraToolParams({ action: "complete_observation", message: "m" })).toThrow("requires delivery");
	});

	it("rejects complete_observation carrying head-management fields", () => {
		expect(() =>
			validateHydraToolParams({ action: "complete_observation", delivery: "none", operation: "add", message: "" }),
		).toThrow("does not accept operation or head");
		expect(() =>
			validateHydraToolParams({ action: "complete_observation", delivery: "none", head: "docs", message: "" }),
		).toThrow("does not accept operation or head");
	});
});

describe("completionFromHydraToolCalls", () => {
	const call = (args: object, name = "hydra") => ({ type: "toolCall", name, arguments: args });
	const completion = { action: "complete_observation", delivery: "none", message: "" };

	it("recovers a valid completion from a sole hydra call among other content", () => {
		expect(
			completionFromHydraToolCalls([
				{ type: "text", text: "done" },
				call({ action: "complete_observation", delivery: "print", message: "note" }),
			]),
		).toEqual({ action: "complete_observation", delivery: "print", message: "note" });
	});

	it("returns null for anything else: two calls, a foreign tool, a management call, invalid arguments, no calls", () => {
		expect(completionFromHydraToolCalls([call(completion), call(completion)])).toBeNull();
		expect(completionFromHydraToolCalls([call(completion, "read")])).toBeNull();
		expect(completionFromHydraToolCalls([call({ action: "manage_heads", operation: "add", head: "docs", message: "m" })])).toBeNull();
		expect(completionFromHydraToolCalls([call({ action: "complete_observation", message: "missing delivery" })])).toBeNull();
		expect(completionFromHydraToolCalls([])).toBeNull();
	});
});

describe("isTerminalHydraAction", () => {
	it("treats a completion and a self-removal (whitespace-tolerant) as terminal", () => {
		expect(isTerminalHydraAction({ action: "complete_observation", delivery: "none", message: "" }, "docs")).toBe(true);
		expect(isTerminalHydraAction({ action: "manage_heads", operation: "remove", head: " docs ", message: "m" }, "docs")).toBe(true);
	});

	it("treats other management calls and non-objects as non-terminal", () => {
		expect(isTerminalHydraAction({ action: "manage_heads", operation: "remove", head: "security", message: "m" }, "docs")).toBe(false);
		expect(isTerminalHydraAction({ action: "manage_heads", operation: "add", head: "docs", message: "m" }, "docs")).toBe(false);
		expect(isTerminalHydraAction(null, "docs")).toBe(false);
		expect(isTerminalHydraAction("complete_observation", "docs")).toBe(false);
	});
});
