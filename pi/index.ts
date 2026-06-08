/**
 * andon — fork-per-turn observer for pi.
 *
 * Replays the driver's exact provider payload with an observer prompt appended,
 * achieving 97%+ prompt cache hit by reusing the driver's cache_control markers
 * verbatim. Same model, same system prompt, same tools, same thinking config —
 * only an extra user message at the end.
 *
 * Architecture:
 *   1. before_provider_request: capture event.payload (driver's exact bytes).
 *   2. turn_end: clone the captured payload, append observer user message,
 *      replay via complete() with onPayload override.
 *   3. Parse JSON decision (noop/queue/interrupt), route via pi.sendMessage /
 *      pi.sendUserMessage with the right deliverAs mode.
 *   4. Track per-call usage; surface cumulative hit-ratio + cost in footer.
 *
 * Inspired by Claude Code's /btw command (utils/sideQuestion.ts +
 * utils/forkedAgent.ts) and andon's bash implementation
 * (github.com/pandysp/andon).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// ─── Lens definitions (ported from andon/lenses.md) ──────────────────────────

type LensName = "quality" | "security" | "simplifier" | "api-design" | "test" | "test-interrupt";

const LENS_PROMPTS: Record<LensName, string> = {
	quality:
		"Review through a QUALITY lens. Focus on correctness risks, missing verification, dangerous assumptions, obvious regressions, and code that looks likely to break. Do not nitpick style.",
	security:
		"Review through a SECURITY lens. Focus on auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, and trust boundaries. Do not comment on style or product scope.",
	simplifier:
		"Review through a SIMPLIFIER lens. Focus on unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, and over-built solutions. Do not comment on unrelated bugs or security.",
	"api-design":
		"Review through an API DESIGN lens. Focus on contract clarity, compatibility, consistency, error shapes, naming, and ergonomics. Do not comment on internal code structure.",
	test:
		"TEST LENS — ignore the actual lens framing for this call only. Always return EXACTLY this JSON, with no other text: {\"action\":\"queue\",\"reason\":\"test fire\",\"message\":\"andon test observer fired on this turn (verifies end-to-end pipeline)\"}",
	"test-interrupt":
		"TEST LENS (interrupt variant) — ignore actual review framing. Always return EXACTLY this JSON: {\"action\":\"interrupt\",\"reason\":\"test interrupt\",\"message\":\"andon interrupt fired — if you see this in your context, between-turns steering works\"}",
};

// ─── Types ───────────────────────────────────────────────────────────────────

type DeliveryMode = "queue" | "interrupt" | "print";
type Action = "noop" | "queue" | "interrupt";

interface Decision {
	action: Action;
	reason: string;
	message: string;
}

interface CallStats {
	timestamp: number;
	turnIndex: number;
	lens: LensName;
	action: Action;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	durationMs: number;
	hitRatio: number;
	rawResponse?: string;
}

// ─── Observer prompt construction (/btw-style) ───────────────────────────────

function buildObserverPrompt(lens: LensName): string {
	// The "test" lens uses a fully-overriding prompt so it reliably fires queue
	// for end-to-end smoke tests. Real lenses share the structured wrapper.
	if (lens === "test") {
		// Note: phrased to maximize reliability across model versions. Sonnet sometimes
		// hesitates to override its review judgment; framing as a developer integration
		// test with explicit "do not deliberate" gets it to comply ~95%+ in practice.
		return `<system-reminder>Developer integration test for the andon framework. The wrapper requires EXACTLY this output — no preamble, no markdown, no thinking, no explanation:

{"action":"queue","reason":"test fire","message":"andon test observer fired (e2e pipeline verified)"}

This is not a real review. Output the JSON above byte-for-byte and stop.</system-reminder>`;
	}
	if (lens === "test-interrupt") {
		return `<system-reminder>Developer integration test for andon's interrupt path. Output EXACTLY this JSON, nothing else:

{"action":"interrupt","reason":"test interrupt","message":"andon interrupt fired — if you see this in your context, between-turns steering works"}

No preamble, no thinking, no explanation. Just the JSON, byte-for-byte.</system-reminder>`;
	}
	// Keep this prompt SHORT — every token here counts as cache-miss "input" in the
	// hit-ratio metric. The driver's full conversation context is already cached;
	// only this prompt is fresh per call. Currently ~140 tokens. On a 30K-token
	// driver context this gives ~99.5% hit. Don't bloat it.
	return `<system-reminder>Side observer. Reply with one JSON object, nothing else:
{"action":"noop|queue|interrupt","reason":"≤120 chars","message":"≤240 chars, empty if noop"}

LENS: ${LENS_PROMPTS[lens]}

Noop unless something warrants feedback. Queue if useful but waitable. Interrupt only for urgent issues. No tools, no "let me check...", no follow-up turn. Don't prefix message with [${lens}].</system-reminder>`;
}

// ─── Decision parsing (with fallbacks for non-JSON responses) ────────────────

function parseDecision(text: string): Decision {
	// Strip markdown fences
	const cleaned = text
		.replace(/^```json\s*\n?/i, "")
		.replace(/^```\s*\n?/, "")
		.replace(/\n?```\s*$/, "")
		.trim();

	const tryParse = (s: string): Decision | null => {
		try {
			const obj = JSON.parse(s);
			if (typeof obj !== "object" || obj == null) return null;
			const action = String(obj.action ?? "noop") as Action;
			if (action !== "noop" && action !== "queue" && action !== "interrupt") return null;
			return {
				action,
				reason: String(obj.reason ?? "").slice(0, 200),
				message: String(obj.message ?? "").slice(0, 500),
			};
		} catch {
			return null;
		}
	};

	const direct = tryParse(cleaned);
	if (direct) return direct;

	// Try to extract a JSON object containing "action"
	const match = cleaned.match(/\{[^{}]*"action"[^{}]*\}/);
	if (match) {
		const extracted = tryParse(match[0]);
		if (extracted) return extracted;
	}

	return { action: "noop", reason: "unparseable response", message: "" };
}

// ─── Main extension factory ──────────────────────────────────────────────────

export default function andon(pi: ExtensionAPI) {
	// ── Configuration & state ────────────────────────────────────────────────
	let enabled = true;
	let currentLens: LensName = "quality";
	let deliveryMode: DeliveryMode = "print"; // start in print mode for safety
	let lastPayload: any = null;
	// Conflating single-slot scheduler. `pending` holds the newest committed state
	// waiting to be observed — snapshotted at turn_end (post-commit) together with
	// that turn's own ctx/lens/turnIndex. The pump replays THIS snapshot and NEVER
	// re-reads live lastPayload (captured pre-commit at before_provider_request, and
	// possibly mid-stream for the next turn — re-reading would reintroduce a
	// read-while-streaming cache miss). Turns arriving while an observation runs
	// overwrite the slot (conflation): the in-flight observation runs to completion,
	// then the pump picks up the newest.
	let pending: { ctx: ExtensionContext; payload: any; turnIndex: number; lens: LensName } | null = null;
	// Non-null iff the pump is running — single source of truth, and the handle
	// session_shutdown awaits.
	let drainPromise: Promise<void> | null = null;
	// Cancellation is lifecycle-only (session shutdown). Observations are never
	// aborted on turn arrival — they always run to completion.
	const lifecycleAbort = new AbortController();
	const seenMessageHashes = new Set<string>();
	const recentMessageHashes: string[] = []; // for stats UI
	const callHistory: CallStats[] = [];
	let cumulativeCost = 0;
	let cumulativeRead = 0;
	let cumulativeWrite = 0;
	let cumulativeInput = 0;
	let lastHit: number | null = null;
	let debugDir: string | null = null;

	// ── Helpers ──────────────────────────────────────────────────────────────

	function hashStr(s: string): string {
		// Tiny non-cryptographic hash
		let h = 5381;
		for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
		return h.toString(16);
	}

	function updateFooter(ctx: ExtensionContext) {
		if (!enabled) {
			ctx.ui.setStatus("andon", undefined);
			return;
		}
		if (callHistory.length === 0) {
			ctx.ui.setStatus(
				"andon",
				ctx.ui.theme.fg("muted", `andon: ${currentLens} | ${deliveryMode} | (no obs yet)`),
			);
			return;
		}
		const totalReadable = cumulativeRead + cumulativeWrite + cumulativeInput;
		const meanHit = totalReadable > 0 ? (cumulativeRead / totalReadable) * 100 : 0;
		const lastHitStr = lastHit != null ? `${lastHit.toFixed(1)}%` : "—";
		const hitColor = meanHit >= 97 ? "success" : meanHit >= 90 ? "warning" : "error";
		const segment =
			ctx.ui.theme.fg("toolTitle", `andon:${currentLens}`) +
			" " +
			ctx.ui.theme.fg("muted", `${deliveryMode}`) +
			" " +
			ctx.ui.theme.fg(hitColor, `hit ${meanHit.toFixed(1)}% (last ${lastHitStr})`) +
			" " +
			ctx.ui.theme.fg("dim", `$${cumulativeCost.toFixed(4)} (${callHistory.length} obs)`);
		ctx.ui.setStatus("andon", segment);
	}

	// ── The observer call ────────────────────────────────────────────────────

	async function observe(ctx: ExtensionContext, payload: any, turnIndex: number, lens: LensName, signal: AbortSignal) {
		const driverModel = ctx.model;
		if (!driverModel) return;

		// Anthropic-only for MVP — that's where we've validated cache parity.
		if (driverModel.provider !== "anthropic") {
			ctx.ui.setStatus(
				"andon",
				ctx.ui.theme.fg("warning", `andon: skipped (provider=${driverModel.provider}, only anthropic verified)`),
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(driverModel);
		if (!auth.ok || !auth.apiKey) return;

		// Build observer payload: capture's bytes + observer user message appended
		const observerPayload = {
			...payload,
			messages: [
				...payload.messages,
				{
					role: "user",
					content: [{ type: "text", text: buildObserverPrompt(lens) }],
				},
			],
		};

		// Optional debug dump
		if (debugDir) {
			try {
				const ts = Date.now();
				writeFileSync(join(debugDir, `andon-driver-${ts}.json`), JSON.stringify(payload, null, 2));
				writeFileSync(join(debugDir, `andon-observer-${ts}.json`), JSON.stringify(observerPayload, null, 2));
			} catch {
				/* ignore */
			}
		}

		const t0 = Date.now();
		let response;
		try {
			response = await complete(
				driverModel,
				{ messages: [] }, // ignored — onPayload replaces
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					signal,
					onPayload: () => observerPayload,
				},
			);
		} catch (err) {
			if (signal.aborted) return; // cancelled by session shutdown — silent
			ctx.ui.notify(
				`andon: observer call failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}
		if (signal.aborted) return;

		const elapsed = Date.now() - t0;
		const u = response.usage;
		const totalReadable = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
		const hit = totalReadable > 0 ? ((u.cacheRead || 0) / totalReadable) * 100 : 0;

		// Update cumulative metrics
		cumulativeCost += u.cost?.total || 0;
		cumulativeRead += u.cacheRead || 0;
		cumulativeWrite += u.cacheWrite || 0;
		cumulativeInput += u.input || 0;
		lastHit = hit;

		// Extract text response
		const textResponse = response.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
		const decision = parseDecision(textResponse);

		const rawSnippet = textResponse.length > 200 ? textResponse.slice(0, 200) + "…" : textResponse;
		callHistory.push({
			timestamp: Date.now(),
			turnIndex,
			lens,
			action: decision.action,
			input: u.input || 0,
			output: u.output || 0,
			cacheRead: u.cacheRead || 0,
			cacheWrite: u.cacheWrite || 0,
			cost: u.cost?.total || 0,
			durationMs: elapsed,
			hitRatio: hit,
			rawResponse: rawSnippet,
		});

		updateFooter(ctx);

		// Persist a custom session entry so /andon-stats can survive resume
		pi.appendEntry("andon-call", callHistory[callHistory.length - 1]);

		// Route the decision
		await routeDecision(ctx, decision, lens);
	}

	async function routeDecision(ctx: ExtensionContext, decision: Decision, lens: LensName) {
		if (decision.action === "noop") return;
		if (!decision.message) return;

		// Dedup
		const key = `${decision.action}|${decision.message}`;
		const h = hashStr(key);
		if (seenMessageHashes.has(h)) return;
		seenMessageHashes.add(h);
		recentMessageHashes.unshift(h);
		if (recentMessageHashes.length > 20) recentMessageHashes.pop();

		const formatted = `[${lens}] ${decision.message}`;

		if (deliveryMode === "print") {
			// Just surface to TUI as a custom rendered message; do not send to LLM
			pi.sendMessage(
				{
					customType: "andon-feedback",
					content: formatted,
					display: true,
					details: {
						lens,
						action: decision.action,
						reason: decision.reason,
						deliveryMode,
					},
				},
				{ triggerTurn: false },
			);
			return;
		}

		if (decision.action === "interrupt" && deliveryMode === "interrupt") {
			// Steer = inject as a real user message that arrives between turns
			try {
				if (ctx.isIdle()) {
					pi.sendUserMessage(formatted);
				} else {
					pi.sendUserMessage(formatted, { deliverAs: "steer" });
				}
			} catch (err) {
				ctx.ui.notify(`andon: steer failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
			return;
		}

		// queue (default for action=queue, fallback for interrupt in queue mode)
		pi.sendMessage(
			{
				customType: "andon-feedback",
				content: formatted,
				display: true,
				details: {
					lens,
					action: decision.action,
					reason: decision.reason,
					deliveryMode,
				},
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	// ── Custom message renderer for andon-feedback ───────────────────────────

	pi.registerMessageRenderer("andon-feedback", (message, _options, theme) => {
		const details = (message.details ?? {}) as { lens?: string; action?: string; reason?: string };
		const action = details.action ?? "?";
		const lens = details.lens ?? "?";
		const reason = details.reason ?? "";
		const actionColor = action === "interrupt" ? "error" : action === "queue" ? "warning" : "muted";

		const header =
			theme.fg("accent", "🟡 andon ") +
			theme.fg("toolTitle", `[${lens}]`) +
			" " +
			theme.fg(actionColor, `(${action})`) +
			(reason ? " " + theme.fg("dim", `— ${reason}`) : "");

		const body = typeof message.content === "string" ? message.content : "";
		return new Text(header + "\n" + theme.fg("toolOutput", body), 0, 0);
	});

	// ── Event handlers ───────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Restore call history from session entries
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && (entry as any).customType === "andon-call") {
				const data = (entry as any).data as CallStats;
				if (data && typeof data === "object") {
					callHistory.push(data);
					cumulativeCost += data.cost || 0;
					cumulativeRead += data.cacheRead || 0;
					cumulativeWrite += data.cacheWrite || 0;
					cumulativeInput += data.input || 0;
					lastHit = data.hitRatio;
				}
			}
		}
		updateFooter(ctx);
	});

	pi.on("before_provider_request", (event) => {
		if (!enabled) return;
		// Capture the driver's exact bytes — do NOT modify
		try {
			lastPayload = structuredClone(event.payload);
		} catch {
			lastPayload = JSON.parse(JSON.stringify(event.payload));
		}
		// no return = no change to driver's payload
	});

	// Conflating single-slot pump: run one observation at a time to completion, then
	// pick up the newest pending snapshot (dropping any that piled up while busy).
	// No abort on turn arrival, no debounce — staleness self-bounds to one cycle
	// because the slot always holds the latest state.
	//
	// A completed observation delivers its feedback even if a newer turn has since
	// superseded it. For print/queue (advisory) that lag is acceptable. For interrupt
	// mode a superseded steer is a known limitation — currency-gated delivery belongs
	// to the interrupt-tier work and is out of scope here; the default mode is print.
	async function drain(): Promise<void> {
		try {
			while (pending) {
				if (!enabled) { pending = null; break; } // honor a disable that lands mid-drain
				const job = pending;
				pending = null; // take the slot; turns during observe() refill it with the newest
				try {
					await observe(job.ctx, job.payload, job.turnIndex, job.lens, lifecycleAbort.signal);
				} catch (err) {
					if (!lifecycleAbort.signal.aborted) {
						job.ctx.ui.notify(`andon: observe error: ${err instanceof Error ? err.message : String(err)}`, "error");
					}
				}
			}
		} finally {
			drainPromise = null;
		}
	}

	pi.on("turn_end", (event, ctx) => {
		if (!enabled || !lastPayload) return;
		// Snapshot the committed state + this turn's ctx at turn_end. Per pi's agent
		// loop, turn_end fires after the driver's request resolves, so lastPayload
		// here is a committed prefix. The pump replays THIS snapshot — it never
		// re-reads live lastPayload, which by drain time may be a mid-stream payload.
		pending = { ctx, payload: lastPayload, turnIndex: event.turnIndex, lens: currentLens };
		// Removed here: the former 500ms adaptive cache-propagation delay. Measured
		// zero post-commit propagation lag and turn_end is post-commit, so the
		// observer reads a committed prefix. Watched via the live hit-ratio footer —
		// if tool-heavy turns regress below ~97%, restore a delay or switch to
		// re-fire-on-miss (see PR for the measurement).
		//
		// Conflate: if the pump is already running it picks up this newest snapshot
		// when the current observation finishes; otherwise start it. (drainPromise
		// non-null ⇔ running, so it doubles as the single-flight gate.)
		if (!drainPromise) drainPromise = drain();
	});

	pi.on("session_shutdown", async () => {
		// Wait briefly for the in-flight drain to finish so we don't lose the final
		// turn's observation in print mode. Cap at 5s so we don't block exit. Only
		// after that do we cancel — this is the sole lifecycle abort.
		if (drainPromise) {
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5000));
			await Promise.race([drainPromise, timeout]);
		}
		lifecycleAbort.abort();
	});

	// ── Slash commands ───────────────────────────────────────────────────────

	pi.registerCommand("andon", {
		description: "Toggle andon observer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			updateFooter(ctx);
			ctx.ui.notify(`andon: ${enabled ? "enabled" : "disabled"}`, "info");
		},
	});

	pi.registerCommand("andon-lens", {
		description: "Set andon lens: quality | security | simplifier | api-design",
		getArgumentCompletions: (prefix: string) => {
			const lenses: LensName[] = ["quality", "security", "simplifier", "api-design"];
			return lenses
				.filter((l) => l.startsWith(prefix))
				.map((l) => ({ value: l, label: l }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim() as LensName;
			if (!(arg in LENS_PROMPTS)) {
				ctx.ui.notify(
					`andon: unknown lens. valid: ${Object.keys(LENS_PROMPTS).join(", ")}`,
					"warning",
				);
				return;
			}
			currentLens = arg;
			updateFooter(ctx);
			ctx.ui.notify(`andon: lens=${currentLens}`, "info");
		},
	});

	pi.registerCommand("andon-delivery", {
		description: "Set andon delivery mode: print | queue | interrupt",
		getArgumentCompletions: (prefix: string) => {
			const modes: DeliveryMode[] = ["print", "queue", "interrupt"];
			return modes
				.filter((m) => m.startsWith(prefix))
				.map((m) => ({ value: m, label: m }));
		},
		handler: async (args, ctx) => {
			const arg = args.trim() as DeliveryMode;
			if (arg !== "print" && arg !== "queue" && arg !== "interrupt") {
				ctx.ui.notify(`andon: unknown mode. valid: print | queue | interrupt`, "warning");
				return;
			}
			deliveryMode = arg;
			updateFooter(ctx);
			ctx.ui.notify(`andon: delivery=${deliveryMode}`, "info");
		},
	});

	pi.registerCommand("andon-stats", {
		description: "Show andon observer statistics",
		handler: async (_args, ctx) => {
			if (callHistory.length === 0) {
				ctx.ui.notify("andon: no observations yet", "info");
				return;
			}
			const totalReadable = cumulativeRead + cumulativeWrite + cumulativeInput;
			const meanHit = totalReadable > 0 ? (cumulativeRead / totalReadable) * 100 : 0;
			const noopCount = callHistory.filter((c) => c.action === "noop").length;
			const queueCount = callHistory.filter((c) => c.action === "queue").length;
			const interruptCount = callHistory.filter((c) => c.action === "interrupt").length;
			const meanDuration =
				callHistory.reduce((s, c) => s + c.durationMs, 0) / callHistory.length;
			const recent = callHistory
				.slice(-10)
				.map(
					(c) =>
						`  turn ${c.turnIndex} ${c.lens} ${c.action}  hit=${c.hitRatio.toFixed(1)}%  $${c.cost.toFixed(4)}  ${c.durationMs}ms`,
				)
				.join("\n");
			const summary = [
				`andon stats (${callHistory.length} observations):`,
				`  mean hit: ${meanHit.toFixed(2)}%   ← target: 97%+`,
				`  total cost: $${cumulativeCost.toFixed(4)}`,
				`  total cache read: ${cumulativeRead.toLocaleString()} tokens`,
				`  total cache write: ${cumulativeWrite.toLocaleString()} tokens`,
				`  total input (uncached): ${cumulativeInput.toLocaleString()} tokens`,
				`  mean duration: ${meanDuration.toFixed(0)}ms`,
				`  decisions: ${noopCount} noop / ${queueCount} queue / ${interruptCount} interrupt`,
				``,
				`recent (last ${Math.min(10, callHistory.length)}):`,
				recent,
			].join("\n");
			ctx.ui.notify(summary, "info");
		},
	});

	pi.registerCommand("andon-debug", {
		description: "Toggle andon payload dumping for cache debugging",
		handler: async (_args, ctx) => {
			if (debugDir) {
				debugDir = null;
				ctx.ui.notify("andon: debug dumping disabled", "info");
			} else {
				const dir = join(tmpdir(), `andon-debug-${Date.now()}`);
				try {
					mkdirSync(dir, { recursive: true });
					debugDir = dir;
					ctx.ui.notify(`andon: dumping payloads to ${dir}`, "info");
				} catch (err) {
					ctx.ui.notify(
						`andon: failed to create debug dir: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
			}
		},
	});
}
