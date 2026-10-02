import type { Decision, DeliveryAction, DeliveryContext, DeliveryRecord, PersistedDelivery } from "./utils.ts";
type PendingRole = "user" | "custom";
type PendingOrigin = "queued" | "idle-user";
export interface DeliveryMessage {
    role: PendingRole;
    content: string;
    customType?: string;
}
export declare class DeliveryLedger {
    private readonly lastByHead;
    private pending;
    private nextId;
    contextFor(head: string): DeliveryContext;
    stage(record: DeliveryRecord, message: {
        role: PendingRole;
        content: string;
        customType?: string;
    }, origin: PendingOrigin): number;
    fail(id: number): DeliveryRecord | null;
    succeed(record: DeliveryRecord): PersistedDelivery;
    consume(message: DeliveryMessage): PersistedDelivery | null;
    discardIdleUserDeliveries(): void;
    settle(): DeliveryRecord[];
    restore(entries: readonly PersistedDelivery[]): void;
    reset(): void;
}
export interface DeliveryGateway {
    isIdle(): boolean;
    abort(): void;
    notify(message: string, level: "info" | "warning"): void;
    sendUserMessage(content: string, options?: {
        deliverAs: "steer" | "followUp";
    }): void;
    sendMessage(message: {
        customType: string;
        content: string;
        display: boolean;
        details: {
            head: string;
            action: DeliveryAction;
            reason: string;
        };
    }, options: {
        deliverAs: "followUp";
        triggerTurn: false;
    }): void;
    persist(entry: PersistedDelivery): void;
}
export declare function consumeDeliveredMessage(ledger: DeliveryLedger, gateway: DeliveryGateway, message: DeliveryMessage): PersistedDelivery | null;
export declare function routeFeedback(ledger: DeliveryLedger, gateway: DeliveryGateway, decision: Decision, head: string, staleSnapshot: boolean): DeliveryAction | "noop";
export {};
