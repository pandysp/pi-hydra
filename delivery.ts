import type { Decision, DeliveryAction, DeliveryContext, DeliveryRecord, PersistedDelivery } from "./utils.ts";

type PendingOrigin = "queued" | "idle-user";

interface PendingDelivery {
	id: number;
	record: DeliveryRecord;
	// The user message the feedback was sent as. Messages that start no turn
	// are recorded when sent, so only user messages wait here.
	content: string;
	origin: PendingOrigin;
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
				.filter((item) => item.record.head === head)
				.map((item) => ({ ...item.record })),
		};
	}

	stage(
		record: DeliveryRecord,
		content: string,
		origin: PendingOrigin,
	): number {
		const id = this.nextId++;
		this.pending.push({ id, record: { ...record }, content, origin });
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

	consume(content: string): PersistedDelivery | null {
		const index = this.pending.findIndex((item) => item.content === content);
		if (index !== -1) {
			const [{ record }] = this.pending.splice(index, 1);
			return this.succeed(record);
		}
		// Feedback sent while the agent was idle leaves no trace in pi's queues,
		// so there is nothing to match against. Seeing a different user message
		// arrive instead is how we learn it never reached the driver.
		this.discardIdleUserDeliveries();
		return null;
	}

	discardIdleUserDeliveries(): void {
		this.pending = this.pending.filter((item) => item.origin !== "idle-user");
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
	notify(message: string, level: "info" | "warning"): void;
	sendUserMessage(content: string, options?: { deliverAs: "steer" }): void;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details: { head: string; action: DeliveryAction; reason: string };
		},
		options: { triggerTurn: false },
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
	content: string,
): PersistedDelivery | null {
	const entry = ledger.consume(content);
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
): DeliveryAction | "noop" {
	if (decision.action === "noop" || !decision.message) return "noop";

	const delivery = decision.action;
	const record: DeliveryRecord = { head, delivery, message: decision.message };
	const formatted = `[pi-hydra ${head}] ${decision.message}`;

	// Deprecated: retained internally, but heads cannot request print.
	if (delivery === "print") {
		try {
			gateway.notify(formatted, "info");
			persistSuccess(ledger, gateway, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			gateway.notify(`hydra: print delivery failed: ${reason}`, "warning");
		}
		return delivery;
	}

	const idle = gateway.isIdle();
	if (delivery === "note") {
		try {
			gateway.sendMessage(
				{
					customType: "hydra-feedback",
					content: formatted,
					display: true,
					details: { head, action: delivery, reason: decision.reason },
				},
				{ triggerTurn: false },
			);
			// A message that starts no turn never announces itself to extensions,
			// so Hydra cannot wait to be told. pi adds it to the session at once
			// when idle, or at the end of the current turn while busy, even when
			// that run was cancelled.
			persistSuccess(ledger, gateway, record);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			gateway.notify(`hydra: note delivery failed: ${reason}`, "warning");
		}
		return delivery;
	}

	const token = ledger.stage(
		record,
		formatted,
		idle ? "idle-user" : "queued",
	);
	try {
		if (idle) {
			gateway.sendUserMessage(formatted);
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
