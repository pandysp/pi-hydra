# Architecture

How hydra observes a pi session through near-pure cache reads. For the what and why, start with the [root README](../README.md); the empirical basis for everything here is [`../experiments/`](../experiments/INDEX.md).

## Commit-point observation

hydra replays the driver's exact provider payload with an observation handoff appended (the driver: pi's main agent, the one you talk to; the heads watch it). Because the prefix is byte-identical, every observation is a prompt-cache read of the entry the driver itself just wrote. On Anthropic the handoff is the combined user prompt. On OpenAI Codex it is the raw head lens as a user message followed by a developer envelope containing hydra's stable protocol; the higher-priority envelope prevents the observer from continuing the driver's task. Observations fire at the driver's own cache commit points, on two triggers:

**Piggyback (mid-run).** When a driver response begins streaming (`message_start`, the moment Anthropic's cache entry becomes readable; commit+0 free rides verified), hydra replays that request's captured payload plus an observation handoff. The driver just paid the cache write, so the observation is a pure cache read, includes the latest assistant message and tool results, and its decision typically lands while the driver's response is still streaming. The run's first response is skipped: the previous run-end observation already reviewed everything before it.

**Run-end (agent_end).** When the driver hands control back to the user, no next request will carry the final assistant message M into the cache, so the observation appends M itself. The observation hands M to its `runAgentLoop` call, and pi-ai's own provider code serializes M: thinking blocks, signatures, surrogate sanitization, parity by construction. On Anthropic, the `onPayload` hook then splices that output onto the captured prefix and moves the driver's message-level cache marker (TTL included) onto M's last markable block (text or tool_use), staying inside the 4-breakpoint budget. The observation carries M either way; the marker turns M from 1.0× fresh input into a 1.25× cache write, a 0.25× premium. The driver's next turn then reads M at 0.1× instead of writing it at 1.25×, saving 1.15×. That is the ~5:1 bet (1.15 against 0.25), and it lands because human latency far exceeds observation TTFT: M's entry is warm long before the next turn needs it. On OpenAI the splice is marker-free; implicit caching breakpoints the latest message server-side. See [OpenAI Codex support](#openai-codex-support).

```
mid-run:  request N+1 dispatched ─► payload captured
          response N+1 begins    ─► PIGGYBACK: replay payload + handoff (pure read)
run end:  agent_end              ─► RUN-END: payload + M(marker) appended
  ↓
runAgentLoop(); onPayload splices pi-ai's own serialization onto the captured bytes
  ↓
provider completion: enumerated judge JSON / acting typed call or JSON
  ↓
apply declared delivery after a successful write/edit
  ↓
none      → log internally as noop
print     → ctx.ui.notify (renders in the TUI, never enters the agent's context)
queue     → pi.sendMessage({ deliverAs: "followUp" })  [internal compatibility only]
steer     → pi.sendUserMessage({ deliverAs: "steer" })
interrupt → ctx.abort() + pi.sendUserMessage({ deliverAs: "followUp" })
```

Model, tools, and thinking config are identical. The only additions are the observation handoff at the end: one combined user message on Anthropic, or user lens plus developer envelope on OpenAI. Cache hit ratio is determined by the handoff's size relative to the driver context.

The provider split is measured, not a compatibility guess. A July 2026 A/B used two real heads, two adjacent randomized replicates in every approved model/thinking cell (40 Anthropic and 48 OpenAI runs), then immutable real-trajectory checkpoints. On OpenAI the first developer-envelope treatment cut extra observer turns from 67 to 3 and preserved total-loop cache hit (83.07% versus 83.30%). It raised review-action accuracy from 72.2% to 84.4%; after the generic envelope was tightened so the lens alone controls scope, intervention thresholds, and deduplication, a fresh treatment run reached 98.9% (88/89 API-successful calls) versus 72.2% for the same saved control cases. Two blinded judges preferred that final treatment 62 times versus 15 for control, with 103 ties. On Anthropic the system envelope left accuracy tied at 64.4%, reduced parse validity from 100% to 96.7%, helped Opus but regressed Sonnet, and added 744 ms mean review latency. A treatment that helps one model and hurts another would need a per-model capability gate, which the design rejects (head and envelope semantics stay general), so Anthropic keeps one combined user prompt for every model. Reversing its message order is not an option: the API rejects a content-bearing mid-conversation system message unless it precedes an assistant message or ends the array.

Observations run through a conflating single-slot scheduler, per head: every head has at most one observation in flight and one waiting slot that a newer snapshot overwrites, and an in-flight observation always runs to completion. Staleness is bounded to one cycle because the slot always holds the newest snapshot. The granularity is per head rather than one global batch so an acting head's minutes-long tool loop cannot starve the judging heads, and a head that is busy through a commit point still reviews the newest snapshot the moment it frees up.

## Heads are files

A head is fully defined by one markdown file ([`heads.md`](heads.md) has the format). Discovery reads `~/.pi/agent/hydra` and the nearest ancestor `.pi/hydra`, project shadowing user, fresh at every `agent_start` and every `hydra` tool call; a vanished file prunes its head from the active set with a notice. The active set is the one piece of state not on disk: it persists as `hydra-config` session entries, restored on resume and branch navigation. At session start the precedence is an explicit `--hydra-heads` flag (present intent), then the saved set (recorded intent), then the files' `autostart` markers (the cold-start default, deliberately not persisted so a resumed session re-reads the files). Which delivery a decision carries normally remains the head's choice. Writing heads may additionally declare `after-change: noop|print`; this fixes delivery only after a successful `write` or `edit` and cannot make unwarranted work warranted.

## Cache hit ratio

| Driver context | Observation prompt | Theoretical hit |
|---:|---:|---:|
| 4K | 220 | 94.8% |
| 10K | 220 | 97.8% |
| 30K | 220 | 99.3% |
| 100K | 220 | 99.8% |

The real measurement below is from the earlier turn_end-era architecture; the current commit-point triggers measure the same or better (live e2e on fable/xhigh: 7/7 piggyback observations were pure cache reads, write=0, and every run-end fork wrote exactly M's tokens). On a multi-prompt session (3 prompts, 4 observations):

```
turn 0 (cold start, 3.5K ctx):  hit 87.79%  read 3552  write 345  input 149
turn 0 (warm, 7.7K ctx):         hit 98.11%  read 7720  write 0    input 149
turn 1 (warm, 16.5K ctx):        hit 99.07%  read 16534 write 0    input 156
turn 0 (warm, 16.7K ctx):        hit 99.12%  read 16741 write 0    input 149
                                 ─────────────────────────────────────────
aggregate hit:                   97.92%
total cost:                      $0.0202 (4 observations)
```

Cold-start observations are bounded by tiny initial context. From roughly 10K of driver context (the table's 97.8% row) every observation hits 97%+, and the session aggregate converges above the 97% target.

## Observation timing

Two measured facts fix the timing (the measurements live in [`../experiments/`](../experiments/INDEX.md)):

- A cache entry becomes readable the moment the writing request's response begins (`message_start` ≈ TTFT). Post-commit propagation is indistinguishable from zero; commit+0 free rides verified on haiku and fable, with and without thinking.
- A response is never cached by the request that produced it. An observation that does not append M itself sees a context that is exactly one assistant message stale.

Hence the two triggers: mid-run observations fire at the driver's own commit (`message_start` of its response), where everything is already cached and fresh through the tool results; run-end observations append M and pay its write once, pre-warming the driver's next turn. No delay or propagation heuristic is needed. The driver's cadence provides the cache-coherent observation points.

M's serialization is parity by construction: the observation hands M to its `runAgentLoop` call, and the `onPayload` hook splices pi-ai's own provider output onto the captured prefix. The fork's bytes match the driver's next request through the exact code path that will produce it, including surrogate sanitization and the dropping of aborted or errored messages. There is no hand-maintained mirror to drift when pi-ai changes.

Selecting M is identity matching. pi constructs the response message about a millisecond before `before_provider_request` fires, so any wall-clock comparison against the capture time is a same-millisecond coin flip that silently drops M on the losing side (measured: -1ms, 0ms, -1ms across three runs). hydra records the response's own timestamp at its `message_start` and attaches M only on an exact match; runs whose final request errored or aborted have no response to match and correctly attach nothing.

Verified end-to-end in June 2026, cross-process (stricter than the normal in-session case, since the session is re-serialized from disk): the piggyback observation was a pure cache read (read 4995, the full committed prefix, write 0); the run-end fork wrote exactly M (342 tok); and the driver's next first request read prefix+M to the token (5337 = 4995 + 342), writing only its new user message (25 tok). Re-verify after pi upgrades with two headless runs. The second run's first `cacheRead` must equal run 1's total (prefix + M), and its `cacheWrite` must be about the new prompt, not about M:

```bash
# HYDRA_SHUTDOWN_GRACE_MS keeps the headless process alive for the run-end
# observation (see Limitations & roadmap)
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p --session-dir /tmp/v "Explain TCP slow start in 200 words, plain text, no tools."
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p -c --session-dir /tmp/v "Thanks. One sentence: what is the congestion window?"
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.usage | [.cacheRead, .cacheWrite, .output] | @csv' /tmp/v/*.jsonl
```

## OpenAI Codex support

GPT-5.6 aligned OpenAI's caching economics with Anthropic's (reads 0.1×, writes billed 1.25×, explicit breakpoints, documented 30-minute retention), which lets the same capture-and-replay design apply nearly unchanged. The ChatGPT Codex backend that pi's `openai-codex` provider talks to turned out to obey almost none of the documented platform semantics, so everything below is measured against it directly (gpt-5.6-luna, July 2026). The probes are checked in ([`codex-cache-scoping.mjs`](../experiments/attic/codex-cache-scoping.mjs) and [`codex-entitlement.mjs`](../experiments/attic/codex-entitlement.mjs), cents of subscription quota); re-run them after pi upgrades or suspicious footer numbers.

**The merge is append-only.** `mergeOpenAIObservationPayload` splices pi-ai's serialization of `[M?, user lens, ...loop turns]` onto the captured `input`, inserts the developer envelope immediately after the lens, and touches nothing else. No marker moves: implicit caching breakpoints the latest message server-side, which is the frontier-advance the Anthropic merge arranges by hand. A marker on M is not even expressible: explicit breakpoints are legal only on input blocks (`input_text`, `input_image`, `input_file`), never on assistant output.

**The OpenAI role split is also an entitlement constraint.** A combined-user tail looks simpler, but after the account's included quota was exhausted, all 24 final-candidate combined-user calls failed with `The usage limit has been reached` and zero usage while their adjacent user-lens-plus-developer-envelope controls succeeded. A minimal alternating probe reproduced the split 2/2 in both orders. Whatever backend routing causes this is outside the extension; keeping the raw lens in user and the protocol in developer is therefore both the higher-quality and the entitlement-safe design.

**Measured backend behavior, and its volatility.** The probes ran on consecutive days and partially disagreed; treat every number here as a dated snapshot, not a constant. Stable across both runs: cache entries behave *session-scoped* in controlled probes (same `prompt_cache_key` from a different session reads nothing; a different key from the same session reads everything), entries become readable within 65 s (a probe at 40 s missed; in full-stack traffic sometimes near-instant), and `cache_write_tokens` is never reported (writes appear free on subscription). Read granularity itself moved: the July 13–14 probes reported 128-token blocks, while the July 24 pi 0.82 causal probe reported 512-token steps. Volatile: entry lifetime was ~2–9 minutes on 2026-07-13 and under ~85 s idle on -14 (never anywhere near the platform's documented 30 minutes); GPT-5.6 refused missing/v4 session ids and the SSE transport outright on -13 (`Model not found gpt-5.6-luna-free-1p-...`, the failure pi-ai's own v4 fallback request id would produce) but accepted all of them on -14. hydra keeps the UUIDv7 id and websocket pin as costless invariants that were required at least once. Full-stack pi traffic also showed occasional cross-session reads of identical content, so treat scoping as multi-signal routing where sharing the session id *guarantees* co-location and anything else is opportunistic. The safety machinery below deliberately depends on none of these numbers: volatility moves the economics (visible in the footer), never the driver's safety.

**Sharing the driver's session is the prize.** Observing under the *driver's* session id means every observation reliably reads the entries the driver itself writes (no cold start, ~87% from a session's first observation), and the run-end write lands where the driver's next turn can find it. It is safe only when the driver sends its full input every turn (pi setting `"transport": "websocket"`, or `"sse"`), and the safety is structural, not just measured: a full-input driver never sends `previous_response_id`, so there is no server-side reference for an observation to evict.

**The fallback is one-way.** Under the default `"auto"`, the driver relies on its websocket *delta continuation*, whose client-side bookkeeping lives in a different pi-ai module instance than the extension's; an observation response under the shared session then evicts the reference server-side and the driver's own next request fails with `Previous response with id 'resp_...' not found` (reproduced 2/2 under `auto`; 0 failures under `websocket`). hydra therefore pins the share decision at the first `agent_start` (the closest an extension gets to the moment the driver was built from the same settings file) and re-resolves the setting *per observation*, because pi's settings selector retargets the live agent mid-session and a cached read would go stale in the unsafe direction. The strategy is monotone: full-input transports observe under the driver's session; the moment any read is a continuation transport, hydra drops to one observer-owned UUIDv7 per extension instance for the rest of the session, never upgrading back (a flip back could resurrect continuation state that shared-mode observations already evicted).

**The tripwire is the backstop.** The fallback is backstopped two ways: measured (zero driver failures across five fallback sessions against an `auto` driver) and actively. If any driver request ends in the continuation-error signature, hydra permanently retreats to its own session for the session and says so, and in-flight acting-head loops wind down at their next turn boundary, converting an unknown backend change from "breaks repeatedly" into "at most one break" (live-fire verified, see [Verifying the tripwire](#verifying-the-tripwire)). One residual race is irreducible client-side and accepted: a settings flip to `"auto"` while a shared observation request is in flight can evict the driver's first post-flip continuation reference; one break at most, which the tripwire then makes final. The delta saves no tokens on this backend (a full-input resend bills its prefix as cache read, measured driver CH ~87% either way), so the `websocket` setting costs the driver upload bandwidth only. The clean fix is upstream: extensions sharing pi's own pi-ai instance would give shared client bookkeeping, which handles the divergence correctly by construction (verified in single-instance reproduction).

**Verified live (July 2026).** Acting heads: a `tools: read` head ran 2-turn tool loops at 84.5%/84.2% first-call parity, decisions annotated, zero errors. Multi-head fan-out: three heads in parallel produced 6 observations at 84.6–85.0% with no connection-limit contention (~$0.012 for the full fan-out on luna). The tripwire, end-to-end: forced sharing against an `auto` driver evicted its continuation, the driver's next request failed with the signature, hydra retreated permanently with the correct notices, and the driver recovered on pi's own retry: one lost request, nothing else. The probe matrix at ~65K tokens: writes readable in under 65 s despite 4× prefill, scoping and key-irrelevance unchanged, entry lifetime still volatile (the ~2-minute control hit at 65K on the same day it missed at 15K).

**Still unverified, named.** pi-ai keeps a per-session SSE-fallback registry that one websocket connect failure can trip permanently: hydra's observations would then run SSE for the rest of the session. The driver is unaffected (separate module instance), but on days the backend refuses SSE for GPT-5.6, every observation fails with a per-observation error until restart. Older codex models (gpt-5.4, gpt-5.5) pass the same gate but their cache economics are unvalidated (visible in the footer if they misbehave). The OpenAI API-key path is out of scope for this project (see below). An Anthropic live re-verification of the `getApiKey` addition waits on an Anthropic login. On subscription codex, observations spend the same account quota as the driver.

**What the numbers mean per provider.** The footer's 97% target is an Anthropic number. On codex, a healthy warm observation reads ~84–87% (measured) and pays the newest turn plus the observation tail as input; `write` stays 0 because the backend doesn't report it. An observation racing the ~1-minute commit window can pay its snapshot as fresh input once (degradation, not failure). The session-level cost reference is the registered production-shaped OpenAI wave of 2026-08-03, six driver runs with two paired observation contracts: ENUM, the shipped enumerate-all-findings judge contract, and MAIN, the single-finding baseline. Across cache-comparable observations (103 of 130 charged calls for MAIN, 108 of 130 for ENUM), MAIN cost $0.0253 per observation and 52.1% of driver cost, while ENUM cost $0.0356 and 77.0%. Charged totals that keep every cache miss, plus the two calls fired after a failed driver turn, raise the ratios to 66.2% and 93.3%. MAIN was cheaper in all six cells. These numbers establish cost only; the quality benchmark is still in progress. See [OPENAI-CAPSTONE-PRODUCER-RESULTS.md](../experiments/OPENAI-CAPSTONE-PRODUCER-RESULTS.md). The per-observation shape, from the July 2026 live e2e in shared mode (`transport: "websocket"`, gpt-5.6-luna, judge-only quality head):

```
turn 1 piggyback:         hit 87.4%  $0.0021   first observation of the session — no cold start
turn 1 run-end:           hit 86.5%  $0.0015
turn 2 run-end:           hit 85.7%  $0.0017
turn 3 piggyback:         hit 84.7%  $0.0018
turn 3 run-end:           hit 84.4%  $0.0016
turn 4 run-end:           hit 84.1%  $0.0017
driver throughout:        CH ~87%, zero errors across every shared-mode run
```

Byte-parity itself was verified separately on every captured pair of the session: the observation payload minus its appended items reproduces the driver payload byte-for-byte (the recipe below).

**The API-key path (`openai/openai-responses`) shares this serializer but stays gated off** in `observe()` until someone measures it: the platform API documents 30-minute retention, itemized `cache_write_tokens`, and key-based scoping, so both its numbers and its economics should differ from the codex backend in hydra's favor.

## Acting heads

By default a head may run tool calls before its decision; a head file's `tools:` frontmatter narrows the executable work set, down to `[]` for a judge-only head. Acting heads retain the `hydra` return action; judge-only heads return the enumerated JSON contract directly. The mechanism extends the replay; it does not replace it:

**The head owns policy; the envelope owns mechanism.** A robust acting head states a positive contract: purpose, the trajectory condition that warrants action, the work, completion, and delivery. The envelope does not infer those from the head name and contains no docs/tuner/foreman branches. It supplies authority, tool allowance, action semantics, and serialization only. A head whose `tools` list explicitly includes `hydra` also receives the active-set snapshot captured when its observation is scheduled; later `hydra` results supersede it. Heads without that explicit capability receive no state inventory.

**Judge completion is one enumerated contract across both providers.** A judge-only head returns `{"findings":[...]}` with one independently labelled entry per finding and an empty list for silence. OpenAI receives the raw lens plus a developer envelope; Anthropic receives one combined prompt. Hydra preserves every message exactly once in at most two recipient batches: `print` findings form one user-only note; `steer` and `interrupt` findings form one agent message, which interrupts only when at least one finding chose it. This keeps the head's user-versus-agent choice instead of promoting unrelated print findings with a more urgent agent finding. Malformed output fails open to `noop` without a recovery call, matching the measured ENUM arm.

**Acting completion keeps its two measured transports.** On OpenAI every non-self-removing acting observation must call `hydra` exactly once with `action: "complete_observation"`, a typed delivery, and a message. The call must be alone in its assistant turn, so all fallible work has completed before "done" can be accepted. A malformed call becomes the ordinary pi tool error the model sees and can correct. On Anthropic the acting head instead returns one compact decision object whose `action` is `noop|print|steer|interrupt`. Hydra validates that object, but the model, not a tool call, produces it; malformed output warns and becomes `noop`. The old queue parser and router remain for compatibility, but no prompt or advertised schema offers queue. `manage_heads` and all acting work remain real tools on both providers.

Acting heads needed their own A/B, separate from the envelope one in [Commit-point observation](#commit-point-observation), because better review behavior did not guarantee better tool behavior. Across 78 randomized OpenAI pairs on the three codex models (luna, terra, and sol), the final generic design (positive head contracts, typed post-mutation delivery, and capability-scoped state) was correct in 77/78 cases (98.7%) versus 63/78 (80.8%) for the prior design, with no treatment-only family regression: docs 29/30 versus 21/30, tuner 18/18 versus 12/18, foreman 30/30 versus 30/30. It also used fewer calls (201 versus 227), cost less ($0.7499 versus $0.8330), and reduced mean latency (7.10 s versus 7.99 s). A separate frozen foreman screen makes the combined foreman result 45/45 versus 44/45. Earlier variants that encoded scenario-specific exceptions were rejected even when they scored well; the shipped mechanism carries only general semantics.

The same final head and delivery contracts were then checked through Anthropic's retained combined-user handoff: 42 pairs across Sonnet, Opus, and Fable scored 38/42 versus 31/42, with seven treatment-only wins, zero control-only wins, and four shared misses. The treatment used 112 calls versus 120, cost $0.7285 versus $0.7782, and reduced mean/p95 latency from 7.37/12.01 s to 7.05/11.67 s. Parse validity was 41/42 versus 42/42: one Sonnet treatment made the correct tuning edit but returned malformed JSON; its paired control also failed semantically. That failure remains visible rather than being repaired post hoc.

The final paired OpenAI A/B covered luna, terra, and sol at low through xhigh: 144 review pairs and 96 acting pairs. Typed completion was valid in 144/144 reviews versus 142/144 for JSON and used exactly one call each, eliminating 23 control retry turns. Semantic review accuracy was effectively flat (42/144 versus 40/144), as were mean latency (6.68 versus 6.71 s); the larger tool contract coincided with 16.7% higher cost. Acting accuracy was 95/96 versus 96/96, with one real Terra foreman miss retained. Terminal self-removal stayed 24/24 and fell from two calls and 5.61 s mean to one call and 3.09 s. The complete KPI table and the symmetric correction of one evaluator synonym are in the [experiment log](../experiments/README.md#enforceable-completion-ab-july-2026).

**Post-mutation delivery is deterministic.** `after-change: noop` says a successful write/edit is the complete work product and requires a `none` completion; `after-change: print` requires a non-empty printed note. OpenAI rejects a conflicting completion as a tool error. Anthropic normalizes its returned decision to the declaration because its completion transport cannot enforce the branch before return. The field requires omitted `tools` or a list containing `write` or `edit`; absent metadata preserves model-chosen delivery. Mutations hidden inside bash are deliberately outside the contract.

**Head management carries its own receipt.** `manage_heads` takes an idempotent add/remove operation, one head, and a required explanation. When an observer actually changes the set, the runtime prints `Added|Removed <head>` plus that explanation immediately; failed and idempotent calls print nothing. The driver sees its own tool result and gets no duplicate notification. Successful self-removal is inherently terminal, so it prints and exits in one call. Removing or adding another head is followed by the ordinary completion action. These rules are caller- and state-based, not foreman-specific.

**Acting loops are pi's own.** Every acting observation runs `runAgentLoop` from pi-agent-core (a first-class extension import; the loader aliases it in both bundle modes) rather than a hand-rolled imitation: argument validation, tool errors, parallel-vs-sequential execution policy, and abort discipline stay pi's code and evolve with it. Judge-only heads make one direct provider call with no executable tools. The same reuse approach applies to M's serialization.

**Every loop call replays the captured prefix.** The loop's own built context is discarded by the `onPayload` merge, so iteration N's request is the byte-true driver prefix plus the observation tail (`[M?, handoff, turn 1, results 1, ..., turn N-1]`). The driver prefix stays a pure cache read on every iteration; measured live, read stayed at the full committed prefix while only tail content was written.

**Tool parity comes from the replay itself.** The replayed prefix carries the driver's active tool schemas byte-for-byte. Acting observations execute the seven standard tools (constructed from pi's exported factories at the driver's cwd), filtered down to the head file's `tools:` list when one is given, plus hydra's shared tool. Inside that tool, `complete_observation` is the acting return channel while `manage_heads` requires omitted tools or an explicit `hydra` allowance. Judge-only heads execute no tools despite seeing the cached schemas. A call outside an acting head's allowance, or to anything hydra cannot execute (another extension's tool, MCP), gets an error result and the head proceeds. write/edit serialize same-file mutations through pi's process-wide queue, shared with the driver because the loader aliases pi-coding-agent to its bundled instance.

**The cache marker advances with the loop.** Cache writes happen only at explicit breakpoints, the budget is four per request, and the driver's payload already spends all four, so the merge only ever moves the deepest message-level marker: onto M for a run-end fork's first call (the pre-warm bet, unchanged), then onto the tail's last markable block once loop turns exist. Each loop turn is written once (plain ephemeral, deliberately without the driver's TTL: the next iteration is seconds away) and read thereafter, instead of re-paid as input every iteration. The prefix+M entry from the first call keeps serving the driver. Anthropic's serving stack was also observed auto-extending entries to the last assistant block on this traffic class without any marker; the explicit advance reproduces those economics within documented semantics instead of relying on observed but undocumented behavior.

**Loops are guarded.** There is no cost ceiling; the only bound is a correctness guard: a loop without a valid completion after 25 model turns is wound down as a `noop` with a warning, and externally removing the head from the active set mid-loop winds it down at the next turn boundary. Completion and successful self-removal stop at that same boundary; neither spends a grace turn. Stats record one `hydra-call` per observation with usage summed across iterations; the hit ratio is taken from the first call alone, since it is the replay-parity signal and later iterations legitimately pay the tail as fresh input.

**The observer owns its provider session.** pi cleans provider resources for the driver's session on shutdown. OpenAI observations may deliberately fall back to hydra's separate session id when sharing would endanger delta continuation, so hydra releases that session itself after winding down its heads. Otherwise a completed headless run remains alive until the cached WebSocket's idle TTL expires.

**File writes are announced.** Every successful write/edit queues a one-line `hydra-feedback` note (`[docs] wrote docs/notes.md`) so the driver is never surprised by files changing under it. The note records provenance for the driver; `after-change: print`, when present, separately controls the user's post-mutation notice. Writes inside the head's bash commands are invisible to both; the authoring guidance in [`heads.md`](heads.md) says to keep bash read-only mid-run.

**Decisions from stale snapshots cannot pull the cord.** An acting head can finish its loop minutes after its snapshot was captured. If the driver has moved on to a newer request, an `interrupt` decision demotes to `steer`: a wrong demotion costs one turn of latency, while a wrong abort destroys in-flight work.

## Limitations & roadmap

**Two providers.** Cache-parity replay is validated on Anthropic's Messages API (97%+ hit ratio) and on the OpenAI Codex backend for GPT-5.6 (~84–87%, no cold start with pi's `"transport": "websocket"`; observer-scoped fallback otherwise, see [OpenAI Codex support](#openai-codex-support)). Everything else (the OpenAI API-key path included) skips observation with a one-time warning until someone measures it; the gate is per provider/API pair in `observe()`.

**Acting heads cannot be hard-aborted mid-tool.** The lifecycle abort signal reaches the loop at turn boundaries and tool executions receive it, but a long-running bash command started by a head runs to completion on shutdown grace expiry. A known limitation, accepted for now.

**Cold-start observation is below 97%.** The first observation in a fresh session has a small driver context that the observation prompt nearly equals in size. Accepted; the metric converges fast once any history exists.

**Headless (`pi -p`) may truncate the run-end observation.** The process exits shortly after `agent_end`; `session_shutdown` awaits the in-flight observation up to 5s, which slow models (fable/xhigh: 10s+) can exceed. Raise via `HYDRA_SHUTDOWN_GRACE_MS` for headless use (`0` means exit without waiting). Interactive mode is unaffected; the observation completes while you read the response.

**Multi-head fan-out is latency-first.** The active head set fans out one observation per head, in parallel, per trigger. Mid-run this is free beyond the prompts, since every head is a pure cache read of the same committed prefix. At run-end the markered forks race and each pays M's write (~$0.01–0.02 per head on fable, measured); the experiments README documents a message_start-coordination pattern that would let followers free-ride on the first fork's write, deliberately not implemented because the contended amount stays a single-digit percent of observation spend and feedback latency is the product metric.

**Decisions judge committed snapshots, not in-flight output.** Interrupt does cancel: an `interrupt` decision calls `ctx.abort()` on the in-flight run and the finding opens the next one, matching the archived bash version's Escape-then-inject behavior. Steer is the softer rung: the message waits for the current turn's tool calls to finish, then lands between turns of the same run, and the piggyback timing means decisions often arrive while a response is still streaming, in time for the very next turn boundary. What remains future work is judging *partial* output: every decision is formed from a committed request snapshot, so a single long-running LLM call is never evaluated mid-generation. That would require reasoning over `message_update` deltas, with no cache parity since the content is mid-flight.

## Module map

There is no build step; pi loads `.ts` via [jiti](https://github.com/unjs/jiti). `index.ts` holds the pi wiring (events, scheduler, commands, rendering); `protocol.ts` holds the hydra tool's wire contract; `delivery.ts` holds the delivery ledger (tests in `delivery.test.ts`); `utils.ts` holds the shared types and the remaining pure logic (decision parsing, payload merge) with tests in `utils.test.ts`. Setup, checks, and the delivery smoke test are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Verifying cache parity

```bash
# In an active pi session running hydra:
/hydra-debug        # toggles dumping
# do some work
/hydra-debug        # toggles off
# inspect (filenames carry timestamp, head, and sequence):
ls /tmp/hydra-debug-*/
# An Anthropic piggyback pair differs only by the combined observation prompt; dropping it
# from the observation payload must reproduce the driver payload byte-for-byte:
jq -S '.' <driver.json> > /tmp/drv.json
jq -S 'del(.messages[-1])' <observation.json> > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json   # expected: empty
# A run-end fork additionally appends M and moves the message-level cache
# marker onto it, so drop both tail messages and the markers before diffing:
jq -S 'walk(if type == "object" then del(.cache_control) else . end)' <driver.json> > /tmp/drv.json
jq -S 'del(.messages[-2:]) | walk(if type == "object" then del(.cache_control) else . end)' <observation.json> > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json   # expected: empty

# OpenAI pairs are input-shaped and marker-free; the observation must be the
# driver payload with items appended (two handoff items for piggyback; M may
# serialize to several, so truncate by driver length instead of a fixed count):
N=$(jq '.input | length' <driver.json>)
jq -S '.' <driver.json> > /tmp/drv.json
jq -S --argjson n "$N" '.input |= .[:$n]' <observation.json> > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json   # expected: empty
```

## Verifying the tripwire

The `agent_end` tripwire is the last line of defense; it can be fired for
real in a throwaway session. `HYDRA_UNSAFE_FORCE_SHARE=1` skips the
transport leg of the share gate (never the monotone state or the tripwire
itself), so observations share the driver's session while the driver runs
its default `"auto"` delta continuation, recreating the exact eviction the
gate exists to prevent. Never set it outside a throwaway session.

```bash
cd /tmp/scratch-project
HYDRA_UNSAFE_FORCE_SHARE=1 pi --model openai-codex/gpt-5.6-luna
# turn 1: observations fire under the driver's session
# turn 2: the driver's delta request fails "Previous response ... not
#         found", the tripwire notice appears, pi's retry recovers the turn
# turn 3+: observations run in their own cache scope; the fallback warning
#         names the tripwire as the cause
```

Verified July 2026: eviction, signature match, permanent retreat, and
driver recovery all observed live; the driver lost one retried request and
nothing else.

## Compared to the archived andon (bash) version

hydra began as [andon](../archive/README.md), a bash and tmux contraption around Claude Code. The design deltas:

| | andon (bash, archived) | pi-hydra |
|---|---|---|
| Cache parity | 8 normalization rules in `andon-cache-fix.mjs` patching `globalThis.fetch` | byte-true replay via `before_provider_request` capture + `onPayload` override on the observation's own provider call |
| Driver inheritance | `claude --resume <id> --fork-session --print` subprocess | `runAgentLoop` call from inside the driver process |
| Observation state | JSON file in `~/.local/state/andon-observer/` | session custom entries via `pi.appendEntry("hydra-call", ...)` |
| Delivery | `tmux send-keys` | `pi.sendMessage` / `pi.sendUserMessage` |
| Polling | JSONL mtime watch loop | driver commit events (`message_start`) + `agent_end` |
| Self-feedback prevention | `recent_decisions` injected into prompt (caused hallucination loops) | factual delivery state from the ledger in the prompt (the head decides); pending feedback becomes part of the replayed context by design, since the head sees exactly what the driver sees |
| Status display | none / external log | TUI footer with live hit ratio + cost |
