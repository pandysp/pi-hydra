import { describe, expect, it } from "vitest";
import { consumeDeliveredMessage, DeliveryLedger, routeFeedback } from "./delivery.ts";
import type { DeliveryGateway } from "./delivery.ts";
import type { PersistedDelivery } from "./utils.ts";
import { parseEnumeratedDecision } from "./utils.ts";

function harness(idle = false) {
	const sentUsers: Array<{ content: string; deliverAs?: string }> = [];
	const sentCustom: string[] = [];
	const notices: Array<{ message: string; level: string }> = [];
	const persisted: PersistedDelivery[] = [];
	let throwOnSend = false;
	const gateway: DeliveryGateway = {
		isIdle: () => idle,
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
		throwOnSend: () => {
			throwOnSend = true;
		},
	};
}

const decision = (action: "print" | "note" | "steer", message = "fix it") => ({
	action,
	reason: "review",
	message,
});

describe("delivery ledger and router", () => {
	it("keeps only the latest successful and live steer deliveries for this head", () => {
		const ledger = new DeliveryLedger();
		ledger.succeed({ head: "security", delivery: "steer", message: "first" });
		ledger.succeed({ head: "security", delivery: "print", message: "latest" });
		ledger.stage({ head: "security", delivery: "steer", message: "same-head pending" }, "[pi-hydra security] same-head pending", "queued");
		ledger.stage({ head: "quality", delivery: "steer", message: "other head" }, "[pi-hydra quality] other head", "queued");
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "print", message: "latest" },
			pending: [{ head: "security", delivery: "steer", message: "same-head pending" }],
		});
	});

	it("moves a matching queued message from pending to successful on message_start", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		routeFeedback(ledger, runtime.gateway, decision("steer"), "security");
		expect(ledger.contextFor("quality").pending).toEqual([]);
		expect(ledger.contextFor("security").pending).toEqual([
			{ head: "security", delivery: "steer", message: "fix it" },
		]);
		consumeDeliveredMessage(ledger, runtime.gateway, "[pi-hydra security] fix it");
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "steer", message: "fix it" },
			pending: [],
		});
		expect(runtime.persisted).toHaveLength(1);
	});

	it("delivers enumerated user and agent findings to their chosen recipients", () => {
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
		const deliveries = parsed.decisions!.map((item) =>
			routeFeedback(ledger, runtime.gateway, item, "security"),
		);
		expect(deliveries).toEqual(["print", "steer"]);
		expect(runtime.notices).toEqual([
			{
				message: "[pi-hydra security] Rotate the credential.",
				level: "info",
			},
		]);
		expect(runtime.sentUsers).toEqual([
			{
				content: "[pi-hydra security] Run the migration.",
				deliverAs: "steer",
			},
		]);
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "print", message: "Rotate the credential." },
			pending: [{ head: "security", delivery: "steer", message: "Run the migration." }],
		});
	});

	it("records note and print immediately, idle or busy, because neither has an extension-visible consume event", () => {
		for (const idle of [true, false]) {
			const ledger = new DeliveryLedger();
			const runtime = harness(idle);
			routeFeedback(ledger, runtime.gateway, decision("note", "later"), "quality");
			expect(ledger.contextFor("quality")).toEqual({ lastByThisHead: { delivery: "note", message: "later" }, pending: [] });
			routeFeedback(ledger, runtime.gateway, decision("print", "rotate it"), "security");
			expect(ledger.contextFor("security").lastByThisHead).toEqual({ delivery: "print", message: "rotate it" });
			expect(runtime.persisted).toHaveLength(2);
		}
	});

	it("does not record synchronous send failures and clears settled orphans", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		runtime.throwOnSend();
		routeFeedback(ledger, runtime.gateway, decision("steer"), "security");
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });

		ledger.stage({ head: "quality", delivery: "steer", message: "orphan" }, "[pi-hydra quality] orphan", "queued");
		expect(ledger.settle()).toEqual([{ head: "quality", delivery: "steer", message: "orphan" }]);
		expect(ledger.contextFor("quality")).toEqual({ lastByThisHead: null, pending: [] });
	});

	it("drops an idle user delivery when a different user message starts first", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		routeFeedback(ledger, runtime.gateway, decision("steer", "expected"), "security");
		expect(ledger.contextFor("security").pending).toEqual([
			{ head: "security", delivery: "steer", message: "expected" },
		]);
		consumeDeliveredMessage(ledger, runtime.gateway, "ordinary user input");
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });
		expect(runtime.persisted).toEqual([]);
	});

	it("drops an idle user delivery when a non-text user message starts", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		routeFeedback(ledger, runtime.gateway, decision("steer", "expected"), "security");
		ledger.discardIdleUserDeliveries();
		expect(ledger.contextFor("security")).toEqual({ lastByThisHead: null, pending: [] });
	});

	it("allows an intentional byte-identical repeat after rejection", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(false);
		ledger.succeed({ head: "security", delivery: "steer", message: "same finding" });
		routeFeedback(ledger, runtime.gateway, decision("steer", "same finding"), "security");
		expect(runtime.sentUsers).toEqual([{ content: "[pi-hydra security] same finding", deliverAs: "steer" }]);
	});

	it("keeps a successful delivery factual even when persisting its receipt fails", () => {
		const ledger = new DeliveryLedger();
		const runtime = harness(true);
		runtime.gateway.persist = () => {
			throw new Error("disk full");
		};
		routeFeedback(ledger, runtime.gateway, decision("print", "visible"), "quality");
		expect(ledger.contextFor("quality").lastByThisHead).toEqual({ delivery: "print", message: "visible" });
		expect(runtime.notices.at(-1)).toEqual({
			message: "hydra: delivered feedback but could not persist its receipt (disk full)",
			level: "warning",
		});
	});

	it("restores only successful branch entries and drops live pending state", () => {
		const ledger = new DeliveryLedger();
		ledger.stage({ head: "security", delivery: "steer", message: "pending" }, "[pi-hydra security] pending", "queued");
		ledger.restore([
			{ head: "security", delivery: "steer", message: "old", timestamp: 1 },
			{ head: "quality", delivery: "note", message: "last", timestamp: 2 },
		]);
		expect(ledger.contextFor("security")).toEqual({
			lastByThisHead: { delivery: "steer", message: "old" },
			pending: [],
		});
	});
});
