import { describe, expect, it } from "vitest";
import { consumeDeliveredMessage, DeliveryLedger, routeFeedback } from "./delivery";
import type { DeliveryGateway } from "./delivery";
import type { PersistedDelivery } from "./delivery-types";
import { parseEnumeratedDecision } from "./utils";

function harness(idle = false) {
	const sentUsers: Array<{ content: string; deliverAs?: string }> = [];
	const sentCustom: string[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const persisted: PersistedDelivery[] = [];
	let aborted = false;
	let throwOnSend = false;
	const gateway: DeliveryGateway = {
		isIdle: () => idle,
		abort: () => {
			aborted = true;
		},
		notify: (message, level) => notices.push({ message, level }),
		sendUserMessage: (content, options) => {
			if (throwOnSend) throw new Error("send failed");
			sentUsers.push({ content, deliverAs: options?.deliverAs });
		},
		sendMessage: (message) => {
			if (throwOnSend) throw new Error("send failed");
			sentCustom.push(message.content);
		},
		persist: (entry) => persisted.push(entry),
	};
	return {
		gateway,
		sentUsers,
		sentCustom,
		notices,
		persisted,
		aborted: () => aborted,
		throwOnSend: () => {
			throwOnSend = true;
		},
	};
}

const decision = (action: "print" | "queue" | "steer" | "interrupt", message = "fix it") => ({
	action,
	reason: "review",
	message,
});

describe("delivery ledger and router", () => {
	it("keeps only the latest successful and live queue/steer deliveries for this head", () => {
		const ledger = new DeliveryLedger();
		ledger.succeed({ head: "security", delivery: "steer", message: "first" });
		ledger.succeed({ head: "security", delivery: "print", message: "latest" });
		ledger.stage(
			{ head: "quality", delivery: "queue", message: "queued" },
			{ role: "custom", customType: "hydra-feedback", content: "[quality] queued" },
			"queued",
		);
		ledger.stage(
			{ head: "security", delivery: "steer", message: "same-head pending" },
			{ role: "user", content: "[security] same-head pending" },
			"queued",
		);
		ledger.stage(
			{ head: "security", delivery: "interrupt", message: "stop" },
			{ role: "user", content: "[security] stop" },
			"queued",
		);
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "print", message: "latest" },
			pending: [{ head: "security", delivery: "steer", message: "same-head pending" }],
		});
		expect(ledger.contextFor("quality").pending).toEqual([
			{ head: "quality", delivery: "queue", message: "queued" },
		]);
	});

	it("moves a matching queued message from pending to successful on message_start", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		routeFeedback(ledger, runtime.gateway, decision("steer"), "security", false);
		expect(ledger.contextFor("quality").pending).toEqual([]);
		expect(ledger.contextFor("security").pending).toEqual([
			{ head: "security", delivery: "steer", message: "fix it" },
		]);
		consumeDeliveredMessage(ledger, runtime.gateway, { role: "user", content: "[security] fix it" });
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "steer", message: "fix it" },
			pending: [],
		});
		expect(runtime.persisted).toHaveLength(1);
	});

	it("delivers every enumerated message at the batch's most urgent chosen action", () => {
		const parsed = parseEnumeratedDecision(
			JSON.stringify({
				findings: [
					{ action: "print", reason: "user", message: "Rotate the credential." },
					{ action: "steer", reason: "agent", message: "Run the migration." },
				],
			}),
		);
		expect(parsed.error).toBeNull();
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		expect(routeFeedback(ledger, runtime.gateway, parsed.decision!, "security", false)).toBe("steer");
		expect(runtime.sentUsers).toEqual([
			{
				content: "[security] Rotate the credential. | Run the migration.",
				deliverAs: "steer",
			},
		]);
	});

	it("tracks a streaming follow-up until its custom message reaches the driver", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		routeFeedback(ledger, runtime.gateway, decision("queue", "check later"), "quality", false);
		expect(ledger.contextFor("security").pending).toEqual([]);
		expect(ledger.contextFor("quality").pending).toEqual([
			{ head: "quality", delivery: "queue", message: "check later" },
		]);
		consumeDeliveredMessage(ledger, runtime.gateway, {
			role: "custom",
			customType: "hydra-feedback",
			content: "[quality] check later",
		});
		expect(ledger.contextFor("quality")).toEqual({
			lastByThisHead: { delivery: "queue", message: "check later" },
			pending: [],
		});
	});

	it("records idle queue and print immediately because neither has an extension-visible consume event", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		routeFeedback(ledger, runtime.gateway, decision("queue", "later"), "quality", false);
		expect(ledger.contextFor("quality").lastByThisHead).toEqual({ delivery: "queue", message: "later" });
		routeFeedback(ledger, runtime.gateway, decision("print", "rotate it"), "security", false);
		expect(ledger.contextFor("security").lastByThisHead).toEqual({ delivery: "print", message: "rotate it" });
		expect(runtime.persisted).toHaveLength(2);
	});

	it("does not record synchronous send failures and clears settled orphans", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		runtime.throwOnSend();
		routeFeedback(ledger, runtime.gateway, decision("steer"), "security", false);
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });

		ledger.stage(
			{ head: "quality", delivery: "queue", message: "orphan" },
			{ role: "custom", customType: "hydra-feedback", content: "[quality] orphan" },
			"queued",
		);
		expect(ledger.settle()).toEqual([{ head: "quality", delivery: "queue", message: "orphan" }]);
		expect(ledger.contextFor("quality")).toEqual({ lastByThisHead: null, pending: [] });
	});

	it("drops an idle user delivery when a different user message starts first", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		routeFeedback(ledger, runtime.gateway, decision("steer", "expected"), "security", false);
		expect(ledger.contextFor("security").pending).toEqual([
			{ head: "security", delivery: "steer", message: "expected" },
		]);
		consumeDeliveredMessage(ledger, runtime.gateway, { role: "user", content: "ordinary user input" });
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });
		expect(runtime.persisted).toEqual([]);
	});

	it("drops an idle user delivery when a non-text user message starts", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		routeFeedback(ledger, runtime.gateway, decision("steer", "expected"), "security", false);
		ledger.discardIdleUserDeliveries();
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });
	});

	it("demotes stale interrupt before staging and preserves live interrupt semantics", () => {
		const staleLedger = new DeliveryLedger();
		const staleRuntime = harness(false);
		expect(routeFeedback(staleLedger, staleRuntime.gateway, decision("interrupt"), "security", true)).toBe("steer");
		expect(staleRuntime.aborted()).toBe(false);
		expect(staleRuntime.sentUsers[0]?.deliverAs).toBe("steer");

		const liveLedger = new DeliveryLedger();
		const liveRuntime = harness(false);
		expect(routeFeedback(liveLedger, liveRuntime.gateway, decision("interrupt"), "security", false)).toBe("interrupt");
		expect(liveRuntime.aborted()).toBe(true);
		expect(liveRuntime.sentUsers[0]?.deliverAs).toBe("followUp");
		expect(liveLedger.contextFor("security").pending).toEqual([]);
	});

	it("allows an intentional byte-identical repeat after rejection", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		ledger.succeed({ head: "security", delivery: "steer", message: "same finding" });
		routeFeedback(ledger, runtime.gateway, decision("steer", "same finding"), "security", false);
		expect(runtime.sentUsers).toEqual([{ content: "[security] same finding", deliverAs: "steer" }]);
	});

	it("keeps a successful delivery factual even when persisting its receipt fails", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		runtime.gateway.persist = () => {
			throw new Error("disk full");
		};
		routeFeedback(ledger, runtime.gateway, decision("print", "visible"), "quality", false);
		expect(ledger.contextFor("quality").lastByThisHead).toEqual({ delivery: "print", message: "visible" });
		expect(runtime.notices.at(-1)).toEqual({
			message: "hydra: delivered feedback but could not persist its receipt (disk full)",
			level: "warning",
		});
	});

	it("restores only successful branch entries and drops live pending state", () => {
		const ledger = new DeliveryLedger();
		ledger.stage(
			{ head: "security", delivery: "steer", message: "pending" },
			{ role: "user", content: "[security] pending" },
			"queued",
		);
		ledger.restore([
			{ head: "security", delivery: "steer", message: "old", timestamp: 1 },
			{ head: "quality", delivery: "queue", message: "last", timestamp: 2 },
		]);
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "steer", message: "old" },
			pending: [],
		});
	});
});
