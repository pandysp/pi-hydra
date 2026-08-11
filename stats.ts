/**
 * Hydra's observation statistics and the persisted session-entry shapes they
 * are rebuilt from. The store owns the per-session call log; the parser owns
 * rebuilding state from a session branch. Rendering (the footer and
 * /hydra-stats) stays in index.ts, which owns the UI.
 */
import type { Action, HydraConfig, PersistedDelivery } from "./utils";

export type ObserveKind = "piggyback" | "run-end";

// One observation call, persisted to the session as a custom "hydra-call" entry
// so /hydra-stats survives resume and branch navigation.
export interface HydraCall {
	timestamp: number;
	turnIndex: number;
	head: string;
	kind?: ObserveKind;
	// A healthy cache hit rate is a different number on each provider, so the
	// two must never be averaged together. Older entries predate this field
	// and are counted as Anthropic, which mislabels a handful of early codex
	// sessions (the 2026-07-15 demo among them). That only affects how old
	// numbers are displayed.
	api?: string;
	// A single observation can now produce two deliveries at once, one shown
	// only to the user and one sent to the agent. Both are kept here. `action`
	// still holds the more urgent of the two, because older code reads it.
	action: Action;
	actions?: Action[];
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	// Always from the first model call of an observation. Later calls in an
	// acting head's loop are supposed to pay full price for the work added
	// since, so counting them would look like a cache problem that is not
	// there.
	hitRatio: number;
	rawResponse?: string;
	// Acting heads only: model turns in the tool loop and the tools executed.
	iterations?: number;
	toolsUsed?: string[];
}

// What counts as healthy depends on the provider: around 97% on Anthropic,
// 84 to 87% measured on codex, where the newest turn is always charged as
// new input. The codex "good" line sits below what was measured, to leave
// room for the backend being uneven. One table feeds both the footer color
// and the /hydra-stats target, so the two cannot drift apart.
export const HIT_BANDS = {
	codex: { good: 80, fair: 60, target: "84%+ (codex)" },
	default: { good: 97, fair: 90, target: "97%+" },
} as const;

export function hitBandsFor(api: string | undefined) {
	return api === "openai-codex-responses" ? HIT_BANDS.codex : HIT_BANDS.default;
}

export class StatsLog {
	private calls: HydraCall[] = [];

	get count(): number {
		return this.calls.length;
	}

	all(): readonly HydraCall[] {
		return this.calls;
	}

	record(call: HydraCall): void {
		this.calls.push(call);
	}

	load(calls: HydraCall[]): void {
		this.calls = calls;
	}

	cumulative(currentApi: string | undefined) {
		let cost = 0;
		let read = 0;
		let write = 0;
		let input = 0;
		let hitRead = 0;
		let hitReadable = 0;
		for (const call of this.calls) {
			cost += call.cost;
			read += call.cacheRead;
			write += call.cacheWrite;
			input += call.input;
			// Cost and token totals cover the whole session, but the average
			// hit rate counts only calls made on the current provider, when
			// there is one to compare against. A rate that was healthy on one
			// provider would otherwise be graded against the other's target
			// after a mid-session switch. Entries with no provider recorded
			// predate codex support and were all Anthropic.
			if (currentApi === undefined || (call.api ?? "anthropic-messages") === currentApi) {
				hitRead += call.cacheRead;
				hitReadable += call.cacheRead + call.cacheWrite + call.input;
			}
		}
		// null, not 0: "no comparable calls yet" (right after a provider
		// switch) must not render as a total cache miss.
		return { cost, read, write, input, meanHit: hitReadable > 0 ? (hitRead / hitReadable) * 100 : null };
	}
}

function persistedDelivery(value: unknown): PersistedDelivery | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<PersistedDelivery>;
	if (
		typeof candidate.head !== "string" ||
		candidate.head.length === 0 ||
		(candidate.delivery !== "print" &&
			candidate.delivery !== "queue" &&
			candidate.delivery !== "steer" &&
			candidate.delivery !== "interrupt") ||
		typeof candidate.message !== "string" ||
		candidate.message.length === 0 ||
		typeof candidate.timestamp !== "number" ||
		!Number.isFinite(candidate.timestamp)
	) {
		return null;
	}
	return candidate as PersistedDelivery;
}

// A persisted call's numbers go straight into arithmetic and `toFixed` in the
// footer, which re-renders after every observation. One truncated or skewed
// entry (a field added later, a half-written session file) would otherwise
// throw on every render for the rest of the session, so a missing number
// restores as 0 rather than taking the UI down. The `lens` fallback here is
// the standing proof that entry skew happens.
const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function persistedCall(data: HydraCall & { lens?: string }): HydraCall {
	return {
		...data,
		head: data.head ?? data.lens ?? "?",
		timestamp: finite(data.timestamp),
		turnIndex: finite(data.turnIndex),
		input: finite(data.input),
		output: finite(data.output),
		cacheRead: finite(data.cacheRead),
		cacheWrite: finite(data.cacheWrite),
		cost: finite(data.cost),
		durationMs: finite(data.durationMs),
		hitRatio: finite(data.hitRatio),
	};
}

export interface BranchEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

// Rebuild hydra's persisted facts from the entries of one session branch.
// `config` stays undefined when no hydra-config entry exists at all: the
// caller distinguishes "never configured" (autostart may seed) from a
// deliberately emptied set, which arrives as `{ heads: [] }`.
export function parseBranchEntries(entries: Iterable<BranchEntryLike>): {
	calls: HydraCall[];
	config: HydraConfig | undefined;
	deliveries: PersistedDelivery[];
} {
	const calls: HydraCall[] = [];
	const deliveries: PersistedDelivery[] = [];
	let config: HydraConfig | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom") {
			continue;
		}
		if (entry.customType === "hydra-call") {
			const data = entry.data as (HydraCall & { lens?: string }) | undefined;
			if (data && typeof data === "object") {
				calls.push(persistedCall(data));
			}
		} else if (entry.customType === "hydra-config") {
			const data = entry.data as HydraConfig | undefined;
			if (data && typeof data === "object") {
				config = data;
			}
		} else if (entry.customType === "hydra-delivery") {
			const data = persistedDelivery(entry.data);
			if (data) deliveries.push(data);
		}
	}
	return { calls, config, deliveries };
}
