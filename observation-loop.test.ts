import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import hydraExtension from "./index";
import type { HydraCall } from "./stats";

type Command = { handler: (args: string, ctx: ExtensionContext) => unknown };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
});

// The host and model are fixtures. The extension, scheduler, Pi agent loop,
// native tools and the Hydra completion tool all execute normally.
async function observation(
	tools: string,
	responses: (fixture: { input: string; settings: string; ctx: ExtensionContext; commands: Map<string, Command> }) => FauxResponseStep[],
) {
	const root = await mkdtemp(join(tmpdir(), "hydra-long-observation-"));
	const agentDir = join(root, "agent");
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, Command>();
	const calls: HydraCall[] = [];
	const notices: { message: string; level: string }[] = [];
	const sessionId = uuidv7();
	const faux = createFauxCore({ api: "openai-codex-responses", provider: "openai-codex" });
	const pi = {
		registerFlag() {},
		getFlag: (name: string) => name === "hydra-heads" ? "long-check" : undefined,
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerMessageRenderer() {},
		registerTool() {},
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		appendEntry: (type: string, data: HydraCall) => {
			if (type === "hydra-call") calls.push(data);
		},
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: root,
		model: faux.getModel(),
		hasUI: true,
		isProjectTrusted: () => false,
		isIdle: () => true,
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			setStatus() {},
			theme: { fg: (_color: string, text: string) => text },
		},
		sessionManager: { getBranch: () => [], getSessionId: () => sessionId },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "offline-fixture-only" }),
			getRegisteredProviderConfig: () => ({ api: faux.api, streamSimple: faux.streamSimple }),
		},
	} as unknown as ExtensionContext;
	const fire = async (name: string, event: unknown) => {
		const handler = handlers.get(name);
		expect(handler).toBeDefined();
		await handler!(event, ctx);
	};
	cleanups.push(async () => {
		try {
			if (handlers.has("session_shutdown")) await fire("session_shutdown", {});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
	vi.stubEnv("HYDRA_UNSAFE_FORCE_SHARE", "0");
	await mkdir(join(agentDir, "hydra"), { recursive: true });
	const settings = join(agentDir, "settings.json");
	await writeFile(settings, JSON.stringify({ transport: "websocket" }));
	await writeFile(join(agentDir, "hydra", "long-check.md"), [
		"---", "name: long-check", "description: Long observation fixture", `tools: ${tools}`, "---",
		"Read the fixture, then complete.",
	].join("\n"));
	const input = join(root, "input.txt");
	await writeFile(input, "owned fixture\n");
	faux.setResponses(responses({ input, settings, ctx, commands }));

	hydraExtension(pi);
	await fire("session_start", { reason: "startup" });
	await fire("agent_start", {});
	await fire("before_provider_request", { payload: { input: [{ role: "user", content: "fixture" }] } });
	const driverMessage = fauxAssistantMessage("Fixture driver response.");
	await fire("message_start", { message: driverMessage });
	await fire("agent_end", { messages: [driverMessage] });
	await vi.waitFor(() => expect(calls).toHaveLength(1));

	const problems = () => notices.filter(item => item.level === "warning" || item.level === "error");
	return { calls, notices, problems, faux, pi };
}

const read = (input: string) => fauxAssistantMessage(fauxToolCall("read", { path: input }), { stopReason: "toolUse" });
const complete = () => fauxAssistantMessage(fauxToolCall("hydra", {
	action: "complete_observation", delivery: "none", message: "",
}), { stopReason: "toolUse" });

it("lets an observation finish after more than 25 tool turns", async () => {
	let reads: ToolResultMessage[] = [];
	const h = await observation("read", ({ input }) => [
		...Array.from({ length: 40 }, () => read(input)),
		(context) => {
			reads = context.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			return complete();
		},
	]);

	expect(h.calls[0].iterations).toBe(41);
	expect(h.calls[0].toolsUsed).toEqual(Array(40).fill("read"));
	expect(reads).toHaveLength(40);
	for (const result of reads) {
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "owned fixture\n" }]);
	}
	expect(h.faux.state.callCount).toBe(41);
	expect(h.faux.getPendingResponseCount()).toBe(0);
	expect(h.calls[0].action).toBe("noop");
	expect(JSON.parse(h.calls[0].rawResponse!)).toEqual({
		action: "complete_observation", delivery: "none", message: "",
	});
	expect(h.problems()).toEqual([]);
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("losing cache sharing stops the loop and is reported even when the same turn completes", async () => {
	const h = await observation("read", ({ input, settings }) => [
		read(input),
		read(input),
		() => {
			// The user switches Pi's transport while the head is working. Pi's
			// default "auto" is not a full-input transport, so sharing must end.
			writeFileSync(settings, "{}");
			return complete();
		},
	]);

	expect(h.faux.state.callCount).toBe(3);
	expect(h.faux.getPendingResponseCount()).toBe(0);
	expect(h.calls[0].iterations).toBe(3);
	expect(h.calls[0].toolsUsed).toEqual(["read", "read"]);
	expect(h.calls[0].action).toBe("noop");
	expect(JSON.parse(h.calls[0].rawResponse!)).toEqual({
		action: "complete_observation", delivery: "none", message: "",
	});
	expect(h.problems()).toEqual([
		{ level: "warning", message: "hydra: long-check wound down after 3 turns (codex cache sharing lost mid-loop)" },
	]);
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("losing cache sharing mid-work stops further requests and records a quiet noop", async () => {
	const h = await observation("read", ({ input, settings }) => [
		read(input),
		() => {
			writeFileSync(settings, "{}");
			return read(input);
		},
		read(input),
	]);

	expect(h.faux.state.callCount).toBe(2);
	expect(h.faux.getPendingResponseCount()).toBe(1);
	expect(h.calls[0].iterations).toBe(2);
	expect(h.calls[0].toolsUsed).toEqual(["read", "read"]);
	expect(h.calls[0].action).toBe("noop");
	// The wind-down is the only warning: no missing-completion complaint.
	expect(h.problems()).toEqual([
		{ level: "warning", message: "hydra: long-check wound down after 2 turns (codex cache sharing lost mid-loop)" },
	]);
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("removing its own head ends the check cleanly after that turn", async () => {
	const h = await observation("read, hydra", ({ input }) => [
		read(input),
		fauxAssistantMessage(fauxToolCall("hydra", {
			action: "manage_heads", operation: "remove", head: "long-check", message: "Fixture no longer needs this head.",
		}), { stopReason: "toolUse" }),
	]);

	expect(h.faux.state.callCount).toBe(2);
	expect(h.faux.getPendingResponseCount()).toBe(0);
	expect(h.calls[0].iterations).toBe(2);
	expect(h.calls[0].toolsUsed).toEqual(["read", "hydra"]);
	expect(h.calls[0].action).toBe("noop");
	expect(h.notices.filter(item => item.level === "info").map(item => item.message)).toEqual([
		expect.stringMatching(/^hydra \[long-check\] .*long-check.*Fixture no longer needs this head\./),
	]);
	expect(h.problems()).toEqual([]);
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});

it("turning the head off from outside stops further requests without a warning", async () => {
	const h = await observation("read", ({ input, ctx, commands }) => [
		read(input),
		() => {
			// The user runs /hydra-heads none while the head is mid-loop.
			void commands.get("hydra-heads")!.handler("none", ctx);
			return read(input);
		},
		read(input),
	]);

	expect(h.faux.state.callCount).toBe(2);
	expect(h.faux.getPendingResponseCount()).toBe(1);
	expect(h.calls[0].iterations).toBe(2);
	expect(h.calls[0].toolsUsed).toEqual(["read", "read"]);
	expect(h.calls[0].action).toBe("noop");
	expect(h.notices.filter(item => item.level === "info").map(item => item.message)).toEqual(["hydra: no heads active"]);
	expect(h.problems()).toEqual([]);
	expect(h.pi.sendMessage).not.toHaveBeenCalled();
});
