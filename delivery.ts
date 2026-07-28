import type { Decision } from "./utils";
import { demoteStaleInterrupt } from "./utils";
import type { DeliveryAction, DeliveryContext, DeliveryRecord, PersistedDelivery } from "./delivery-types";

type PendingRole = "user" | "custom";
type PendingOrigin = "queued" | "idle-user";

interface PendingDelivery {
	id: number;
	record: DeliveryRecord;
	role: PendingRole;
	content: string;
	customType?: string;
	origin: PendingOrigin;
}

export interface DeliveryMessage {
	role: PendingRole;
	content: string;
	customType?: string;
}

export class DeliveryLedger {
	private readonly lastByHead = new Map<string, DeliveryRecord>();
	private pending: PendingDelivery[] = [];
	private nextId = 1;

	contextFor(head: string): DeliveryContext {
		const last = this.lastByHead.get(head);
		return {
			lastByThisHead: last ? { delivery: last.delivery, message: last.message } : null,
			pending: this.pending
				.filter(
					(item) =>
						item.record.head === head &&
						(item.record.delivery === "queue" || item.record.delivery === "steer"),
				)
				.map((item) => ({ ...item.record })),
		};
	}

	stage(
		record: DeliveryRecord,
		message: { role: PendingRole; content: string; customType?: string },
		origin: PendingOrigin,
	): number {
		const id = this.nextId++;
		this.pending.push({ id, record: { ...record }, ...message, origin });
		return id;
	}

	fail(id: number): DeliveryRecord | null {
		const index = this.pending.findIndex((item) => item.id === id);
		if (index === -1) return null;
		return this.pending.splice(index, 1)[0].record;
	}

	succeed(record: DeliveryRecord): PersistedDelivery {
		const copy = { ...record };
		this.lastByHead.set(record.head, copy);
		return { ...copy, timestamp: Date.now() };
	}

	consume(message: DeliveryMessage): PersistedDelivery | null {
		const index = this.pending.findIndex(
			(item) =>
				item.role === message.role &&
				item.content === message.content &&
				(item.role !== "custom" || item.customType === message.customType),
		);
		if (index !== -1) {
			const [{ record }] = this.pending.splice(index, 1);
			return this.succeed(record);
		}
		// An idle send is not represented in Pi's queues. If another user
		// message starts instead, the send failed before reaching the driver.
		if (message.role === "user") {
			this.pending = this.pending.filter((item) => item.origin !== "idle-user");
		}
		return null;
	}

	settle(): DeliveryRecord[] {
		const orphaned = this.pending.map((item) => ({ ...item.record }));
		this.pending = [];
		return orphaned;
	}

	restore(entries: readonly PersistedDelivery[]): void {
		this.reset();
		for (const entry of entries) {
			this.lastByHead.set(entry.head, {
				head: entry.head,
				delivery: entry.delivery,
				message: entry.message,
			});
		}
	}

	reset(): void {
		this.lastByHead.clear();
		this.pending = [];
		this.nextId = 1;
	}
}

export interface DeliveryGateway {
	isIdle(): boolean;
	abort(): void;
	notify(message: string, level: "info" | "warning"): void;
	sendUserMessage(content: string, options?: { deliverAs: "steer" | "followUp" }): void;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: { head: string; action: DeliveryAction; reason: string };
		},
		options: { deliverAs: "followUp"; triggerTurn: false },
	): void;
	persist(entry: PersistedDelivery): void;
}

function persistSuccess(ledger: DeliveryLedger, gateway: DeliveryGateway, record: DeliveryRecord): void {
	const entry = ledger.succeed(record);
	try {
		gateway.persist(entry);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		gateway.notify(`hydra: delivered feedback but could not persist its receipt (${reason})`, "warning");
	}
}

export function consumeDeliveredMessage(
	ledger: DeliveryLedger,
	gateway: DeliveryGateway,
	message: DeliveryMessage,
): PersistedDelivery | null {
	const entry = ledger.consume(message);
	if (!entry) return null;
	try {
		gateway.persist(entry);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		gateway.notify(`hydra: delivered feedback but could not persist its receipt (${reason})`, "warning");
	}
	return entry;
}

export function routeFeedback(
	ledger: DeliveryLedger,
	gateway: DeliveryGateway,
	decision: Decision,
	head: string,
	staleSnapshot: boolean,
): DeliveryAction | "noop" {
	if (decision.action === "noop" || !decision.message) return "noop";

	const delivery = demoteStaleInterrupt(decision.action, staleSnapshot) as DeliveryAction;
	const record: DeliveryRecord = { head, delivery, message: decision.message };
	const formatted = `[${head}] ${decision.message}`;

	if (delivery === "print") {
		try {
			gateway.notify(`hydra ${formatted}`, "info");
			persistSuccess(ledger, gateway, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			gateway.notify(`hydra: print delivery failed: ${reason}`, "warning");
		}
		return delivery;
	}

	const idle = gateway.isIdle();
	if (delivery === "queue" && idle) {
		try {
			gateway.sendMessage(
				{
					customType: "hydra-feedback",
					content: formatted,
					display: true,
					details: { head, action: delivery, reason: decision.reason },
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
			// Idle custom messages join session state immediately but do not emit
			// an extension-visible message_start event.
			persistSuccess(ledger, gateway, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			gateway.notify(`hydra: queue delivery failed: ${reason}`, "warning");
		}
		return delivery;
	}

	const role = delivery === "queue" ? "custom" : "user";
	const token = ledger.stage(
		record,
		{ role, content: formatted, customType: role === "custom" ? "hydra-feedback" : undefined },
		idle ? "idle-user" : "queued",
	);
	try {
		if (delivery === "queue") {
			gateway.sendMessage(
				{
					customType: "hydra-feedback",
					content: formatted,
					display: true,
					details: { head, action: delivery, reason: decision.reason },
				},
				{ deliverAs: "followUp", triggerTurn: false },
			);
		} else if (idle) {
			gateway.sendUserMessage(formatted);
		} else if (delivery === "interrupt") {
			gateway.abort();
			gateway.sendUserMessage(formatted, { deliverAs: "followUp" });
		} else {
			gateway.sendUserMessage(formatted, { deliverAs: "steer" });
		}
	} catch (error) {
		ledger.fail(token);
		const reason = error instanceof Error ? error.message : String(error);
		gateway.notify(`hydra: ${delivery} delivery failed: ${reason}`, "warning");
	}
	return delivery;
}
