import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { streamSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import hydraExtension from "./index";
import type { HydraCall } from "./stats";

const boundary = vi.hoisted(() => ({ agentDir: "", afterFileTool: undefined as undefined | (() => Promise<void>) }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => {
	const pi = await original<typeof import("@earendil-works/pi-coding-agent")>();
	const wrap = (factory: (cwd: string) => AgentTool) => (cwd: string) => {
		const tool = factory(cwd);
		return { ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
			const result = await tool.execute(...args);
			await boundary.afterFileTool?.();
			return result;
		} };
	};
	return {
		...pi,
		getAgentDir: () => boundary.agentDir,
		SettingsManager: { ...pi.SettingsManager, create: () => pi.SettingsManager.inMemory({ transport: "websocket" }) },
		createWriteTool: wrap(pi.createWriteTool),
		createEditTool: wrap(pi.createEditTool),
	};
});

function answer(content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant", content, stopReason, api: "anthropic-messages", provider: "anthropic", model: "test",
		usage: { input: 10, output: 5, cacheRead: 90, cacheWrite: 0, totalTokens: 105, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	};
}
const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (name: string, args: Record<string, unknown>): ToolCall => ({ type: "toolCall", id: `call-${name}`, name, arguments: args });
const noop = () => answer([text('{"findings":[]}')]);

type CustomSend = Parameters<ExtensionAPI["sendMessage"]>[0];
type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => unknown;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	boundary.afterFileTool = undefined;
	vi.unstubAllEnvs();
});

async function harness(options: { tools?: string; afterChange?: string; api?: "anthropic-messages" | "openai-codex-responses" } = {}) {
	const cwd = mkdtempSync(join(process.cwd(), ".observer-test-"));
	boundary.agentDir = join(cwd, "agent");
	mkdirSync(join(cwd, ".pi", "hydra"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "hydra", "critic.md"), `---\nname: critic\ndescription: Test observer\ntools: ${options.tools ?? "[]"}\n${options.afterChange ? `after-change: ${options.afterChange}\n` : ""}---\nFollow these test instructions.\n`);
	const sm = SessionManager.inMemory(cwd);
	const root = sm.appendCustomEntry("hydra-config", { heads: ["critic"] });
	const handlers = new Map<string, Handler>();
	const responses: (AssistantMessage | Promise<AssistantMessage>)[] = [];
	const payloads: unknown[] = [];
	const pending: CustomSend[] = [];
	let idle = true;
	const api = options.api ?? "anthropic-messages";
	const model = { api, provider: api === "anthropic-messages" ? "anthropic" : "openai-codex", id: "test", contextWindow: 200000, maxTokens: 4096 } as Model<Api>;
	const transport = vi.fn((model: Model<Api>, context: { messages: Message[] }, opts: { onPayload: (payload: unknown) => unknown }) => {
		const built = model.api === "anthropic-messages" ? { messages: context.messages } : { input: context.messages };
		payloads.push(opts.onPayload(built));
		const next = responses.shift();
		if (!next) throw new Error("Unexpected provider call (repair or runaway loop)");
		return { result: async () => next, async *[Symbol.asyncIterator]() { await next; } };
	}) as unknown as typeof streamSimple & ReturnType<typeof vi.fn>;
	const notify = vi.fn();
	const ctx = {
		cwd, model, sessionManager: sm, isIdle: () => idle, isProjectTrusted: () => true, hasUI: true,
		ui: { notify, setStatus: vi.fn(), theme: { fg: (_: string, value: string) => value } },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test" }),
			getRegisteredProviderConfig: () => ({ api, streamSimple: transport }),
		},
		abort: vi.fn(),
	} as unknown as ExtensionContext;
	const consume = async (message: CustomSend) => {
		sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		await emit({ type: "message_start", message: { ...message, role: "custom", timestamp: Date.now() } });
	};
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerFlag: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(),
		getFlag: () => undefined,
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
		// Model active-session delivery; consumer.test.ts covers Pi's async failures.
		sendMessage: vi.fn((message: CustomSend) => {
			if (idle) sm.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			else pending.push(message);
		}),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	async function emit(event: ExtensionEvent) { await handlers.get(event.type)?.(event, ctx); }
	hydraExtension(pi);
	await emit({ type: "session_start", reason: "startup" });
	const calls = () => sm.getBranch().filter(e => e.type === "custom" && e.customType === "hydra-call").map(e => (e as { data: HydraCall }).data);
	const notices = () => sm.getBranch().filter(e => e.type === "custom_message" && e.customType === "hydra-runtime-report");
	const observe = async (...results: (AssistantMessage | Promise<AssistantMessage>)[]) => {
		responses.push(...results);
		const messages = convertToLlm(sm.buildSessionContext().messages);
		await emit({ type: "before_provider_request", payload: api === "anthropic-messages" ? { messages } : { input: messages } });
		await emit({ type: "message_start", message: answer([text("Driver is working")]) });
	};
	await emit({ type: "agent_start" });
	// The first main assistant response is deliberately skipped by Hydra.
	await emit({ type: "before_provider_request", payload: api === "anthropic-messages" ? { messages: [] } : { input: [] } });
	await emit({ type: "message_start", message: answer([text("First driver response")]) });
	cleanups.push(async () => {
		await emit({ type: "session_shutdown", reason: "quit" });
		rmSync(cwd, { recursive: true, force: true });
	});
	return { cwd, sm, root, ctx, pi, payloads, pending, transport, notify, emit, consume, observe, calls, notices,
		busy: () => { idle = false; }, idle: () => { idle = true; },
		waitCalls: async (count: number) => { await vi.waitFor(() => expect(calls(), JSON.stringify(notify.mock.calls)).toHaveLength(count)); },
	};
}

describe("heads without tools through the extension", () => {
	it.each(["anthropic-messages", "openai-codex-responses"] as const)("%s never executes or repairs a tool request and reports it in future context", async (api) => {
		const h = await harness({ api });
		const target = join(h.cwd, "must-not-exist");
		await h.observe(answer([tool("write", { path: target, content: "SECRET-ARGUMENT" }), text('{"findings":[{"action":"steer","reason":"mixed","message":"MUST NOT DELIVER"}]}')], "toolUse"));
		await h.waitCalls(1);
		expect(existsSync(target)).toBe(false);
		expect(h.transport).toHaveBeenCalledTimes(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: "blocked-tool-request", attemptedTools: ["write"], stopReason: "toolUse" });
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.notices()).toHaveLength(1);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "hydra-runtime-report" }), { deliverAs: "steer" });
		await h.observe(noop());
		await h.waitCalls(2);
		const [report] = vi.mocked(h.pi.sendMessage).mock.calls[0];
		const payload = JSON.stringify(h.payloads[1]);
		expect(payload).toContain(JSON.stringify(report.content).slice(1, -1));
		expect(payload).not.toContain("SECRET-ARGUMENT");
	});

	it.each([
		["cut short", answer([tool("write", { path: "bad" }), text('{"findings":')], "length"), "truncated", false],
		["empty", answer(), "empty-answer", false],
		["empty zero-usage", { ...answer(), usage: { ...answer().usage, input: 0, cacheRead: 0, output: 0, totalTokens: 0 } }, "empty-answer", false],
		["thinking-only", answer([{ type: "thinking", thinking: "SECRET-THINKING" }]), "empty-answer", false],
		["malformed", answer([text("SECRET-PROSE")]), "malformed-findings", true],
		["provider error", { ...answer([tool("write", {})], "error"), errorMessage: "provider unavailable" }, "provider-error", false],
		["provider abort", answer([tool("write", {})], "aborted"), "aborted", false],
	] as const)("records %s without guessing why it happened", async (_name, response, kind, report) => {
		const h = await harness();
		await h.observe(response);
		await h.waitCalls(1);
		expect(h.calls()[0]).toMatchObject({ action: "noop", judgeErrorKind: kind });
		expect(h.notices()).toHaveLength(report ? 1 : 0);
		expect(JSON.stringify(h.notices())).not.toMatch(/SECRET-PROSE|SECRET-THINKING/);
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining(kind), expect.any(String));
	});

	it("keeps valid noop, print and steer separate", async () => {
		const h = await harness();
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0]).not.toHaveProperty("judgeErrorKind", expect.any(String));
		await h.observe(answer([text(JSON.stringify({ findings: [
			{ action: "print", message: "USER ONLY", reason: "user" },
			{ action: "steer", message: "DRIVER ACTION", reason: "driver" },
		] }))]));
		await h.waitCalls(2);
		expect(h.notify).toHaveBeenCalledWith("hydra [critic] USER ONLY", "info");
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("[critic] DRIVER ACTION", undefined);
		expect(h.notices()).toHaveLength(0);
	});
});

describe("one error notice per head and error type", () => {
	const blocked = () => answer([tool("write", { path: "ignored", content: "not executed" })], "toolUse");
	it("sends each error notice once per head and type, even after a successful check", async () => {
		const h = await harness();
		h.busy();
		await h.observe(blocked());
		await h.waitCalls(1);
		await h.observe(blocked());
		await h.waitCalls(2);
		expect(h.pending).toHaveLength(1);
		await h.consume(h.pending.shift()!);
		await h.observe(noop());
		await h.waitCalls(3);
		await h.observe(blocked());
		await h.waitCalls(4);
		expect(h.pending).toHaveLength(0);
		await h.observe(answer([text("not JSON")]));
		await h.waitCalls(5);
		expect(h.pending).toHaveLength(1);
		expect(h.notify.mock.calls.filter(([message]) => message.includes("blocked-tool-request"))).toHaveLength(3);
		expect(JSON.stringify(h.payloads[4])).toContain('\\"lastByThisHead\\":null');
	});

	it("coalesces checks without queuing a second notice before the first arrives", async () => {
		const h = await harness();
		h.busy();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		// The main assistant advances while the first head check is still running.
		await h.observe(blocked());
		expect(h.transport).toHaveBeenCalledTimes(1);
		finish(blocked());
		await h.waitCalls(2);
		// Both checks finished, but the main assistant has not drained its queue.
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.pending).toHaveLength(1);
		expect(h.notices()).toHaveLength(0);
		await h.consume(h.pending.shift()!);
		await h.emit({ type: "agent_settled" });
		expect(h.notices()).toHaveLength(1);
		expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("error notice(s) did not reach"), "warning");
	});

	it("allows a notice that never arrived to be sent on a later check", async () => {
		const h = await harness();
		h.busy();
		await h.observe(blocked());
		await h.waitCalls(1);
		h.pending.splice(0); // Host abort cleared its queue, not a successful delivery.
		await h.emit({ type: "agent_settled" });
		expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("error notice(s) did not reach"), "warning");
		h.idle();
		await h.observe(blocked());
		await h.waitCalls(2);
		expect(h.notices()).toHaveLength(1);
	});

	it("surfaces an expired extension API as an observation error, not a retryable send failure", async () => {
		const h = await harness();
		// Pi's API guard throws for expired extensions before its async sender runs.
		vi.mocked(h.pi.sendMessage).mockImplementation(() => { throw new Error("Extension context is stale"); });
		await h.observe(blocked());
		await vi.waitFor(() => expect(h.notify).toHaveBeenCalledWith("hydra: observe error: Extension context is stale", "error"));
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.notices()).toHaveLength(0);
	});

	it("restores only actual messages on the selected branch, not attempted sends or call records", async () => {
		const h = await harness();
		h.busy();
		await h.observe(blocked());
		await h.waitCalls(1);
		h.pending.splice(0);
		await h.emit({ type: "session_start", reason: "reload" });
		h.idle();
		await h.observe(blocked());
		await h.waitCalls(2);
		expect(h.notices()).toHaveLength(1);
		const withNotice = h.sm.getLeafId()!;
		await h.emit({ type: "session_start", reason: "reload" });
		await h.observe(blocked());
		await h.waitCalls(3);
		expect(h.notices()).toHaveLength(1);
		h.sm.branch(h.root);
		await h.emit({ type: "session_tree", oldLeafId: withNotice, newLeafId: h.root });
		await h.observe(blocked());
		await h.waitCalls(1);
		expect(h.notices()).toHaveLength(1);
		h.sm.branch(withNotice);
		await h.emit({ type: "session_tree", oldLeafId: h.root, newLeafId: withNotice });
		await h.observe(blocked());
		await h.waitCalls(3);
		expect(h.notices()).toHaveLength(1);
	});

	it("does not inject stale-branch results", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		h.sm.branch(h.root);
		await h.emit({ type: "session_tree", oldLeafId: h.root, newLeafId: h.root });
		finish(blocked());
		await h.observe(noop());
		await h.waitCalls(1);
		expect(h.calls()[0].judgeErrorKind).toBeUndefined();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("records an error notice finishing inside the shutdown grace without starting a main assistant turn", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		const shutdown = h.emit({ type: "session_shutdown", reason: "quit" });
		finish(blocked());
		await shutdown;
		expect(h.calls()).toHaveLength(1);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "hydra-runtime-report" }), { deliverAs: "steer" });
		expect(h.notices()).toHaveLength(1);
	});

	it("does not inject a response arriving after cancellation", async () => {
		const h = await harness();
		let finish!: (response: AssistantMessage) => void;
		await h.observe(new Promise(resolve => { finish = resolve; }));
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(1));
		vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
		await h.emit({ type: "session_shutdown", reason: "quit" });
		finish(blocked());
		await h.emit({ type: "session_shutdown", reason: "quit" });
		expect(h.calls()).toHaveLength(0);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("file notices through real tools", () => {
	it.each([false, true])("a successful read neither announces a file change nor resets a prior write (%s)", async (wrote) => {
		const h = await harness({ tools: "read, write", afterChange: "noop" });
		writeFileSync(join(h.cwd, "work.txt"), "before");
		await h.observe(
			...(wrote ? [answer([tool("write", { path: "work.txt", content: "after" })], "toolUse")] : []),
			answer([tool("read", { path: "work.txt" })], "toolUse"),
			answer([text('{"action":"steer","reason":"checked","message":"Completion note"}')]),
		);
		await h.waitCalls(1);
		expect(h.payloads.at(-1)).toHaveProperty("messages", expect.arrayContaining([
			expect.objectContaining({ role: "toolResult", toolName: "read", isError: false }),
		]));
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(wrote ? 1 : 0);
		expect(h.calls()[0].action).toBe(wrote ? "noop" : "steer");
	});

	it.each(["noop", "print"])("announces successful write/edit before completion independently of after-change %s", async (afterChange) => {
		const h = await harness({ tools: "write, edit", afterChange });
		await h.observe(
			answer([tool("write", { path: "work.txt", content: "before" })], "toolUse"),
			answer([tool("edit", { path: "work.txt", edits: [{ oldText: "before", newText: "after" }] })], "toolUse"),
			answer([text('{"action":"steer","reason":"changed","message":"Completion note"}')]),
		);
		await h.waitCalls(1);
		expect(readFileSync(join(h.cwd, "work.txt"), "utf8")).toBe("after");
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(2);
		for (const [message, options] of vi.mocked(h.pi.sendMessage).mock.calls) {
			expect(options).toEqual({ deliverAs: "steer" });
			expect(message.content).toContain("reread");
		}
		expect(h.calls()[0].action).toBe(afterChange);
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it.each(["noop", "print"])("Codex enforces after-change %s without delaying the independent write notice", async (afterChange) => {
		const h = await harness({ api: "openai-codex-responses", tools: "write", afterChange });
		await h.observe(
			answer([tool("write", { path: "work.txt", content: "written" })], "toolUse"),
			answer([tool("hydra", { action: "complete_observation", delivery: "steer", message: "wrong delivery" })], "toolUse"),
			answer([tool("hydra", { action: "complete_observation", delivery: afterChange === "noop" ? "none" : "print", message: afterChange === "noop" ? "" : "Changed file" })], "toolUse"),
		);
		await h.waitCalls(1);
		expect(readFileSync(join(h.cwd, "work.txt"), "utf8")).toBe("written");
		expect(h.calls()[0]).toMatchObject({ action: afterChange, iterations: 3, toolsUsed: ["write"] });
		expect(h.pi.sendMessage).toHaveBeenCalledTimes(1);
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("reread this file") }), { deliverAs: "steer" });
		expect(JSON.stringify(h.payloads[2])).toContain('"isError":true');
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("announces a known successful write even if shutdown follows, recorded without a main assistant turn", async () => {
		const h = await harness({ tools: "write" });
		vi.stubEnv("HYDRA_SHUTDOWN_GRACE_MS", "0");
		boundary.afterFileTool = () => h.emit({ type: "session_shutdown", reason: "quit" });
		await h.observe(answer([tool("write", { path: "work.txt", content: "written" })], "toolUse"));
		await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledTimes(1));
		expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "hydra-feedback" }), { deliverAs: "steer" });
		expect(readFileSync(join(h.cwd, "work.txt"), "utf8")).toBe("written");
		expect(h.calls()).toHaveLength(0);
	});

	it("keeps old-branch write facts out of the new branch", async () => {
		const h = await harness({ tools: "write" });
		boundary.afterFileTool = async () => {
			h.sm.branch(h.root);
			await h.emit({ type: "session_tree", oldLeafId: h.root, newLeafId: h.root });
		};
		await h.observe(
			answer([tool("write", { path: "work.txt", content: "written" })], "toolUse"),
			answer([text('{"action":"noop","reason":"done","message":""}')]),
		);
		await vi.waitFor(() => expect(h.transport).toHaveBeenCalledTimes(2));
		await h.emit({ type: "session_shutdown", reason: "quit" });
		expect(readFileSync(join(h.cwd, "work.txt"), "utf8")).toBe("written");
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.calls()).toHaveLength(0);
	});

	it("does not announce success for failing write or edit tools", async () => {
		const h = await harness({ tools: "write, edit" });
		mkdirSync(join(h.cwd, "directory"));
		await h.observe(
			answer([tool("write", { content: "missing path" })], "toolUse"),
			answer([tool("edit", { edits: [{ oldText: "before", newText: "after" }] })], "toolUse"),
			answer([tool("write", { path: "directory", content: "bad" })], "toolUse"),
			answer([tool("edit", { path: "missing", edits: [{ oldText: "before", newText: "after" }] })], "toolUse"),
			answer([text('{"action":"noop","reason":"failed","message":""}')]),
		);
		await h.waitCalls(1);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
});
