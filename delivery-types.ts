import type { Action } from "./utils";

export type DeliveryAction = Exclude<Action, "noop">;

export interface DeliveryRecord {
	head: string;
	delivery: DeliveryAction;
	message: string;
}

export interface DeliveryContext {
	lastByThisHead: Omit<DeliveryRecord, "head"> | null;
	pending: DeliveryRecord[];
}

export interface PersistedDelivery extends DeliveryRecord {
	timestamp: number;
}
