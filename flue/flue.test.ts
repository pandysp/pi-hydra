// End to end through real Flue (runtime, durable store, hooks) with a scripted model.
// The script builds an Anthropic-shaped request body and passes it through onPayload, the way
// pi-ai's real providers do, so capture, merge and replay run exactly as they would live.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as v from "valibot";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, GeneralSubagent, init, observe, useModel, useSubagent, useTool } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra, type FlueHydra, type HydraRecord } from "./index.ts";

type Sent = { messages: { role: string; content: { type: string; text: string }[] }[]; options?: { sessionId?: string; transport?: string } };
const text = (sent: Sent) => JSON.stringify(sent.messages);
const isHeadRequest = (sent: Sent) => text(sent).includes("You are reviewing the main assistant's work");

function headFile(name: string, extra = "tools: []"): string {
	const dir = mkdtempSync(join(tmpdir(), "hydra-flue-test-"));
	const path = join(dir, `${name}.md`);
	writeFileSync(path, `---\nname: ${name}\ndescription: test head\n${extra}\n---\nCheck the answer.\n`);
	return path;
}

// A scripted model: `driver` answers the agent's requests, `head` answers head requests.
function scripted(api: string, driver: (sent: Sent, index: number) => ReturnType<typeof fauxAssistantMessage>, head: (sent: Sent, index: number) => string) {
	const faux = fauxProvider({ provider: "test", api, models: [{ id: "m", contextWindow: 4000, maxTokens: 100 }] });
	const sent: Sent[] = [];
	let drivers = 0, heads = 0;
	faux.setResponses([async function step(context: any, options: any, _state: unknown, model: any) {
		faux.appendResponses([step]);
		const messages = context.messages.map((m: any) => ({ role: m.role === "toolResult" ? "user" : m.role, content: [{ type: "text", text: JSON.stringify(m.content) }] }));
		// Codex names the conversation `input`; normalized back to `messages` for the assertions.
		const params: any = api === "openai-codex-responses"
			? { model: model.id, input: messages, prompt_cache_key: options?.sessionId }
			: { model: model.id, system: [{ type: "text", text: String(context.systemPrompt ?? "") }], messages };
		const raw: any = (await options?.onPayload?.(params, model)) ?? params;
		const body: Sent = { messages: raw.messages ?? raw.input, options: { sessionId: options?.sessionId, transport: options?.transport } };
		sent.push(body);
		return isHeadRequest(body) ? fauxAssistantMessage(head(body, heads++)) : driver(body, drivers++);
	}]);
	return { provider: faux.provider, sent };
}

const findings = (...items: { action: string; message: string }[]) => JSON.stringify({ findings: items.map((item) => ({ reason: "test", ...item })) });

let hydra: FlueHydra | undefined;
let runtime: { stop(): Promise<void> } | undefined;
afterEach(async () => {
	await runtime?.stop();
	await hydra?.close();
	runtime = hydra = undefined;
});

async function run(options: { api?: string; heads?: string[]; maxRounds?: number; agent?: (hydra: FlueHydra) => () => string; driver: Parameters<typeof scripted>[1]; head: Parameters<typeof scripted>[2]; messages?: string[] }) {
	const records: HydraRecord[] = [];
	const logs: { level: string; message: string }[] = [];
	const unobserve = observe((event) => { if (event.type === "log") logs.push({ level: event.level, message: event.message }); });
	const model = scripted(options.api ?? "anthropic-messages", options.driver, options.head);
	hydra = createFlueHydra({ heads: options.heads ?? [headFile("checker")], maxRounds: options.maxRounds, onRecord: (record) => records.push(record) });
	const h = hydra;
	const Agent = options.agent?.(h) ?? function Agent() { useModel("test/m"); h.useHydra(); return "You answer questions."; };
	runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [h.wrap(model.provider)] });
	const handle = init(Agent);
	const replies = [];
	for (const message of options.messages ?? ["What is 17 times 23?"]) replies.push(await handle.read(await handle.dispatch(message)));
	unobserve();
	return { replies, records, logs, sent: model.sent };
}

describe("pi-hydra heads in Flue", () => {
	it("a steer is appended, the agent corrects, and the next check settles the response", async () => {
		const result = await run({
			driver: (_sent, i) => fauxAssistantMessage(i === 0 ? "17 × 23 = 401" : "Corrected: 391"),
			head: (_sent, i) => (i === 0 ? findings({ action: "steer", message: "17 × 23 is 391 <not 401> & check \"tools\"" }) : findings()),
		});
		expect(result.replies[0].text).toMatch(/Corrected: 391$/);
		expect(result.records.map((r) => [r.round, r.outcome])).toEqual([[0, "findings"], [1, "none"]]);
		const [driver1, head1, driver2] = result.sent;
		// The head replays the driver's request unchanged, then the final answer, then its prompt.
		expect(head1.messages.slice(0, driver1.messages.length)).toEqual(driver1.messages);
		expect(JSON.stringify(head1.messages[driver1.messages.length])).toContain("401");
		// The finding reaches the agent's next request exactly once.
		expect(text(driver2).split("[pi-hydra checker]").length - 1).toBe(1);
		expect(text(driver2)).toContain("391");
	});

	it("a print finding is logged for people and never reaches the agent", async () => {
		const result = await run({
			driver: () => fauxAssistantMessage("391"),
			head: () => findings({ action: "print", message: "looks fine, by the way" }),
		});
		expect(result.records).toHaveLength(1);
		expect(result.logs).toContainEqual({ level: "info", message: "[pi-hydra checker] looks fine, by the way" });
		expect(result.sent.filter((s) => !isHeadRequest(s))).toHaveLength(1);
	});

	it("interrupt is delivered like steer", async () => {
		const result = await run({
			driver: (_sent, i) => fauxAssistantMessage(i === 0 ? "401" : "391"),
			head: (_sent, i) => (i === 0 ? findings({ action: "interrupt", message: "wrong product" }) : findings()),
		});
		expect(result.replies[0].text).toMatch(/391$/);
		expect(text(result.sent.filter((s) => !isHeadRequest(s))[1])).toContain("[pi-hydra checker] wrong product");
	});

	it("a failed check is logged as a warning and recorded; the response settles", async () => {
		const result = await run({ driver: () => fauxAssistantMessage("391"), head: () => "not json" });
		expect(result.replies[0].text).toBe("391");
		expect(result.records[0]).toMatchObject({ outcome: "failed", errorKind: "malformed-findings" });
		expect(result.logs.some((log) => log.level === "warn" && log.message.startsWith("[pi-hydra checker] check failed"))).toBe(true);
	});

	it("after maxRounds of feedback the findings are logged as unresolved and the response settles", async () => {
		const result = await run({
			maxRounds: 2,
			driver: (_sent, i) => fauxAssistantMessage(`attempt ${i}`),
			head: () => findings({ action: "steer", message: "still wrong" }),
		});
		expect(result.replies[0].text).toMatch(/attempt 2$/);
		expect(result.records.map((r) => r.round)).toEqual([0, 1, 2]);
		expect(result.logs.some((log) => log.level === "warn" && log.message.includes("unresolved after 2 rounds"))).toBe(true);
	});

	it("after a terminating tool the head sees the real tool result", async () => {
		const result = await run({
			agent: (h) => function Agent() {
				useModel("test/m");
				useTool(defineTool({ name: "submit", description: "Submit.", input: v.object({ answer: v.number() }), run: ({ data }) => ({ output: `stored ${data.answer}`, terminate: true }) }));
				h.useHydra();
				return "Submit the answer.";
			},
			driver: () => fauxAssistantMessage(fauxToolCall("submit", { answer: 401 }), { stopReason: "toolUse" }),
			head: () => findings(),
		});
		const head = result.sent.find(isHeadRequest)!;
		expect(text(head)).toContain("stored 401");
		expect(text(head)).not.toContain("No result provided");
	});

	it("subagent calls are not reviewed as the conversation; the head replays the agent's own last request", async () => {
		const result = await run({
			agent: (h) => function Agent() { useModel("test/m"); useSubagent(GeneralSubagent); h.useHydra(); return "Delegate, then answer."; },
			driver: (sent) => text(sent).includes("sub task please")
				? fauxAssistantMessage("sub result")
				: text(sent).includes("sub result")
					? fauxAssistantMessage("final answer")
					: fauxAssistantMessage(fauxToolCall("task", { agent: "flue-general", prompt: "sub task please" }), { stopReason: "toolUse" }),
			head: () => findings(),
		});
		const lastDriver = result.sent.filter((s) => !isHeadRequest(s)).at(-1)!;
		const head = result.sent.find(isHeadRequest)!;
		expect(text(lastDriver)).toContain("sub result");
		expect(head.messages.slice(0, lastDriver.messages.length)).toEqual(lastDriver.messages);
	});

	it("a compaction after the agent's last request is not reviewed as the conversation", async () => {
		// Flue compacts right after a run's final turn once the threshold is crossed, before the
		// finish hook: the summarization request is then the last provider call the head could see.
		const result = await run({
			agent: (h) => function Agent() { useModel("test/m", { compaction: { reserveTokens: 1000, keepRecentTokens: 20 } }); h.useHydra(); return "Answer briefly."; },
			driver: (sent) => {
				const summarizing = text(sent).includes("context summarization assistant");
				const message = fauxAssistantMessage(summarizing ? "## Summary\nearlier work" : "noted " + "x".repeat(20));
				message.usage = { ...message.usage, input: summarizing ? 10 : 3900, totalTokens: summarizing ? 10 : 3900 };
				return message;
			},
			head: () => findings(),
			messages: Array.from({ length: 6 }, (_, i) => `message ${i} ${"w".repeat(2000)}`),
		});
		const isSummary = (s: Sent) => text(s).includes("context summarization assistant");
		let headsRightAfterSummary = 0;
		result.sent.forEach((sent, index) => {
			if (!isHeadRequest(sent)) return;
			const before = result.sent.slice(0, index);
			if (isSummary(before.at(-1)!)) headsRightAfterSummary++;
			const lastAgent = before.filter((s) => !isHeadRequest(s) && !isSummary(s)).at(-1)!;
			expect(sent.messages.slice(0, lastAgent.messages.length)).toEqual(lastAgent.messages);
		});
		expect(headsRightAfterSummary).toBeGreaterThan(0);
	});

	it("Codex heads share the driver's session over a full-input transport", async () => {
		const result = await run({ api: "openai-codex-responses", driver: () => fauxAssistantMessage("391"), head: () => findings() });
		const [driver, head] = result.sent;
		expect(isHeadRequest(head)).toBe(true);
		expect(driver.options?.transport).toBe("websocket");
		expect(driver.options?.sessionId).toBeTruthy();
		expect(head.options).toEqual(driver.options);
		expect(result.records[0]).toMatchObject({ outcome: "none" });
	});

	it("an unsupported provider API is reported, not silently skipped", async () => {
		const result = await run({ api: "test-api", driver: () => fauxAssistantMessage("391"), head: () => findings() });
		expect(result.records[0]).toMatchObject({ outcome: "failed", errorKind: "unsupported-api" });
		expect(result.sent.some(isHeadRequest)).toBe(false);
	});

	it("an agent whose provider is not wrapped reports that heads could not run", async () => {
		const records: HydraRecord[] = [];
		const model = scripted("anthropic-messages", () => fauxAssistantMessage("391"), () => findings());
		hydra = createFlueHydra({ heads: [headFile("checker")], onRecord: (record) => records.push(record) });
		const h = hydra;
		function Agent() { useModel("test/m"); h.useHydra(); return "x"; }
		runtime = await start({ agents: [{ agent: Agent, name: "agent" }], providers: [model.provider] });
		const handle = init(Agent);
		await handle.read(await handle.dispatch("hi"));
		expect(records[0]).toMatchObject({ outcome: "failed", errorKind: "no-capture" });
	});

	it("heads that use tools or are invalid are refused at creation", () => {
		expect(() => createFlueHydra({ heads: [headFile("actor", "tools: read")] })).toThrow(/judge heads only/);
		expect(() => createFlueHydra({ heads: [headFile("open", "description2: x")] })).toThrow(/invalid head file/);
		expect(() => createFlueHydra({ heads: [] })).toThrow(/no heads/);
	});
});
