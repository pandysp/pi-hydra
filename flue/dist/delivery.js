import { demoteStaleInterrupt } from "./utils.js";
export class DeliveryLedger {
    lastByHead = new Map();
    pending = [];
    nextId = 1;
    contextFor(head) {
        const last = this.lastByHead.get(head);
        return {
            lastByThisHead: last ? { delivery: last.delivery, message: last.message } : null,
            pending: this.pending
                .filter((item) => item.record.head === head &&
                (item.record.delivery === "queue" || item.record.delivery === "steer"))
                .map((item) => ({ ...item.record })),
        };
    }
    stage(record, message, origin) {
        const id = this.nextId++;
        this.pending.push({ id, record: { ...record }, ...message, origin });
        return id;
    }
    fail(id) {
        const index = this.pending.findIndex((item) => item.id === id);
        if (index === -1)
            return null;
        return this.pending.splice(index, 1)[0].record;
    }
    succeed(record) {
        const copy = { ...record };
        this.lastByHead.set(record.head, copy);
        return { ...copy, timestamp: Date.now() };
    }
    consume(message) {
        const index = this.pending.findIndex((item) => item.role === message.role &&
            item.content === message.content &&
            (item.role !== "custom" || item.customType === message.customType));
        if (index !== -1) {
            const [{ record }] = this.pending.splice(index, 1);
            return this.succeed(record);
        }
        // Feedback sent while the agent was idle leaves no trace in pi's queues,
        // so there is nothing to match against. Seeing a different user message
        // arrive instead is how we learn it never reached the driver.
        if (message.role === "user") {
            this.discardIdleUserDeliveries();
        }
        return null;
    }
    discardIdleUserDeliveries() {
        this.pending = this.pending.filter((item) => item.origin !== "idle-user");
    }
    settle() {
        const orphaned = this.pending.map((item) => ({ ...item.record }));
        this.pending = [];
        return orphaned;
    }
    restore(entries) {
        this.reset();
        for (const entry of entries) {
            this.lastByHead.set(entry.head, {
                head: entry.head,
                delivery: entry.delivery,
                message: entry.message,
            });
        }
    }
    reset() {
        this.lastByHead.clear();
        this.pending = [];
        this.nextId = 1;
    }
}
function persistSuccess(ledger, gateway, record) {
    const entry = ledger.succeed(record);
    try {
        gateway.persist(entry);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        gateway.notify(`hydra: delivered feedback but could not persist its receipt (${reason})`, "warning");
    }
}
export function consumeDeliveredMessage(ledger, gateway, message) {
    const entry = ledger.consume(message);
    if (!entry)
        return null;
    try {
        gateway.persist(entry);
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        gateway.notify(`hydra: delivered feedback but could not persist its receipt (${reason})`, "warning");
    }
    return entry;
}
export function routeFeedback(ledger, gateway, decision, head, staleSnapshot) {
    if (decision.action === "noop" || !decision.message)
        return "noop";
    const delivery = demoteStaleInterrupt(decision.action, staleSnapshot);
    const record = { head, delivery, message: decision.message };
    const formatted = `[pi-hydra ${head}] ${decision.message}`;
    if (delivery === "print") {
        try {
            gateway.notify(formatted, "info");
            persistSuccess(ledger, gateway, record);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            gateway.notify(`hydra: print delivery failed: ${reason}`, "warning");
        }
        return delivery;
    }
    const idle = gateway.isIdle();
    if (delivery === "queue" && idle) {
        try {
            gateway.sendMessage({
                customType: "hydra-feedback",
                content: formatted,
                display: true,
                details: { head, action: delivery, reason: decision.reason },
            }, { deliverAs: "followUp", triggerTurn: false });
            // Sent while idle, these land in the session straight away but never
            // announce themselves, so an extension cannot wait to be told.
            persistSuccess(ledger, gateway, record);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            gateway.notify(`hydra: queue delivery failed: ${reason}`, "warning");
        }
        return delivery;
    }
    const role = delivery === "queue" ? "custom" : "user";
    const token = ledger.stage(record, { role, content: formatted, customType: role === "custom" ? "hydra-feedback" : undefined }, idle ? "idle-user" : "queued");
    try {
        if (delivery === "queue") {
            gateway.sendMessage({
                customType: "hydra-feedback",
                content: formatted,
                display: true,
                details: { head, action: delivery, reason: decision.reason },
            }, { deliverAs: "followUp", triggerTurn: false });
        }
        else if (idle) {
            gateway.sendUserMessage(formatted);
        }
        else if (delivery === "interrupt") {
            gateway.abort();
            gateway.sendUserMessage(formatted, { deliverAs: "followUp" });
        }
        else {
            gateway.sendUserMessage(formatted, { deliverAs: "steer" });
        }
    }
    catch (error) {
        ledger.fail(token);
        const reason = error instanceof Error ? error.message : String(error);
        gateway.notify(`hydra: ${delivery} delivery failed: ${reason}`, "warning");
    }
    return delivery;
}
