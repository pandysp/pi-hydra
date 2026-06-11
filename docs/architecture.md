# Architecture

How hydra observes a pi session at prompt-cache prices. For the what and why, start with the [root README](../README.md); the empirical basis for everything here is [`../experiments/`](../experiments/README.md).

## Commit-point observation

hydra replays the driver's exact provider payload with one observer prompt appended. Because the prefix is byte-identical, every observation is a prompt-cache read of the entry the driver itself just wrote. Observations fire at the driver's own cache commit points, on two triggers:

**Piggyback (mid-run).** When a driver response begins streaming (`message_start`, the moment Anthropic's cache entry becomes readable; commit+0 free rides verified), hydra replays that request's captured payload plus an observer prompt. The driver just paid the cache write, so the observation is a pure cache read, includes the latest assistant message and tool results, and its verdict typically lands while the driver's response is still streaming.

**Run-end (agent_end).** When the agent hands control back to the user, no next driver request will carry the final assistant message M into the cache, so hydra forks from n: it passes M through `complete()` so pi-ai's own provider code serializes it (thinking blocks, signatures, surrogate sanitization; parity by construction rather than by mirroring), then the `onPayload` hook splices that output onto the captured prefix and moves the driver's message-level cache marker (TTL included) onto M's last markable block (text or tool_use), staying inside the 4-breakpoint budget. The observer pays M's write once (1.25×) and pre-warms the driver's next turn, which reads M at 0.1×: a ~5:1 bet that lands because human latency far exceeds observer TTFT.

```
mid-run:  request N+1 dispatched ─► payload captured
          response N+1 begins    ─► PIGGYBACK: replay payload + prompt (pure read)
run end:  agent_end              ─► RUN-END: payload + M(marker) appended (fork-from-n)
  ↓
complete(); onPayload splices pi-ai's own serialization onto the captured bytes
  ↓
parse JSON decision
  ↓
noop      → log only
queue     → pi.sendMessage({ deliverAs: "followUp" })
steer     → pi.sendUserMessage({ deliverAs: "steer" })
interrupt → ctx.abort() + pi.sendUserMessage({ deliverAs: "followUp" })
(the delivery mode caps the force a verdict can request)
```

Same model, same system prompt, same tools, same thinking config; the only difference is one extra user message at the end. Cache hit ratio is determined by the size of the observer prompt (~220 tokens) relative to the driver context.

Observations run through a conflating single-slot scheduler: at most one batch in flight (one observation per active lens, fanned out in parallel), a newer snapshot overwrites the waiting slot, and an in-flight batch always runs to completion. Staleness is bounded to one cycle because the slot always holds the newest snapshot.

## Cache hit ratio (the load-bearing metric)

| Driver context | Observer prompt | Theoretical hit |
|---:|---:|---:|
| 4K | 220 | 94.8% |
| 10K | 220 | 97.8% |
| 30K | 220 | 99.3% |
| 100K | 220 | 99.8% |

Real measurement on a multi-prompt session (3 prompts, 4 observations):

```
turn 0 (cold start, 3.5K ctx):  hit 87.79%  read 3552  write 345  input 149
turn 0 (warm, 7.7K ctx):         hit 98.11%  read 7720  write 0    input 149
turn 1 (warm, 16.5K ctx):        hit 99.07%  read 16534 write 0    input 156
turn 0 (warm, 16.7K ctx):        hit 99.12%  read 16741 write 0    input 149
                                 ─────────────────────────────────────────
aggregate hit:                   97.92%
total cost:                      $0.0202 (4 observations)
```

Cold-start observations are bounded by tiny initial context. Once any conversation history exists, every subsequent observation hits 97%+, and the aggregate over any non-trivial session converges above the 97% target.

The measurement above is from the earlier turn_end-era architecture. The current commit-point triggers measure the same or better: in the live e2e on fable/xhigh, 7/7 piggyback observations were pure cache reads (write=0) and every run-end fork wrote exactly M's tokens.

## Observation timing

Earlier versions observed at `turn_end` and worried about cache propagation races (an adaptive 500ms delay existed at one point). The experiments in [`../experiments/`](../experiments/README.md) settled the mechanics:

- A cache entry becomes readable when the writing request's response begins (`message_start` ≈ TTFT). Post-commit propagation is indistinguishable from zero; commit+0 free rides verified on haiku and fable, with and without thinking.
- A response is never cached by the request that produced it. The old `turn_end` fork was therefore structurally stale by exactly the latest assistant message, which caused the stale-review bug this design fixes.

Hence the two triggers: mid-run observations fire at the driver's own commit (`message_start` of its response), where everything is already cached and fresh through the tool results; run-end observations fork-from-n and pay for the final M once, pre-warming the driver's next turn. No delays, no propagation heuristics. The driver's cadence provides the cache-coherent observation points.

M's serialization is parity by construction: the observer passes M through `complete()`, and the `onPayload` hook splices pi-ai's own provider output onto the captured prefix. The fork's bytes match the driver's next request through the exact code path that will produce it, including surrogate sanitization and the dropping of aborted or errored messages. There is no hand-maintained mirror to drift when pi-ai changes.

Verified end-to-end in June 2026, cross-process (stricter than the normal in-session case, since the session is re-serialized from disk): the piggyback observation was a pure cache read (read 4995, the full committed prefix, write 0); the run-end fork wrote exactly M (342 tok); and the driver's next first request read prefix+M to the token (5337 = 4995 + 342), writing only its new user message (25 tok). Re-verify after pi upgrades with two headless runs. The second run's first `cacheRead` must equal run 1's total (prefix + M), and its `cacheWrite` must be about the new prompt, not about M:

```bash
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p --session-dir /tmp/v "Explain TCP slow start in 200 words, plain text, no tools."
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p -c --session-dir /tmp/v "Thanks. One sentence: what is the congestion window?"
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.usage | [.cacheRead, .cacheWrite, .output] | @csv' /tmp/v/*.jsonl
```

## Limitations & roadmap

**Anthropic-only for v0.1.** The capture/replay pattern requires the provider to support prompt caching with explicit `cache_control` markers, validated so far only on Anthropic's Messages API. OpenAI, Google etc. would either need their own cache markers or fall through to no-cache (still works, but expensive). Detected at runtime: hydra skips observation, with a one-time warning, when the driver is on a non-Anthropic provider.

**Cold-start observation is below 97%.** The first observation in a fresh session has a small driver context that the observer prompt nearly equals in size. Accepted; the metric converges fast once any history exists.

**Headless (`pi -p`) may truncate the run-end observation.** The process exits shortly after `agent_end`; `session_shutdown` awaits the in-flight observation up to 5s, which slow models (fable/xhigh: 10s+) can exceed. Raise via `HYDRA_SHUTDOWN_GRACE_MS` for headless use (`0` means exit without waiting). Interactive mode is unaffected; the observation completes while you read the response.

**Multi-head fan-out is latency-first.** The active lens set fans out one observation per head, in parallel, per trigger. Mid-run this is free beyond the prompts, since every head is a pure cache read of the same committed prefix. At run-end the markered forks race and each pays M's write (~$0.01–0.02 per head on fable, measured); the experiments README documents a message_start-coordination pattern that would let followers free-ride on the first fork's write, deliberately not implemented because the contended amount stays a single-digit percent of observer spend and feedback latency is the product metric.

**Verdicts judge committed snapshots, not in-flight output.** Interrupt delivery does cancel: an `interrupt` verdict calls `ctx.abort()` on the in-flight run and the finding opens the next one, matching the archived bash version's Escape-then-inject behavior. Steer delivery is the softer rung: the message waits for the current turn's tool calls to finish, then lands between turns of the same run, and the piggyback timing means verdicts often arrive while a response is still streaming, in time for the very next turn boundary. What remains future work is judging *partial* output: every verdict is formed from a committed request snapshot, so a single long-running LLM call is never evaluated mid-generation. That would require reasoning over `message_update` deltas, with no cache parity since the content is mid-flight.

## Development

```bash
cd pi-hydra
npm install        # dev tooling only; users installing the extension inherit nothing
npm run check      # tsc --strict
npm test           # vitest on the pure helpers
# Edit index.ts / utils.ts, then reload pi (Ctrl-R or /reload) to pick up changes
```

There is no build step; pi loads `.ts` via [jiti](https://github.com/unjs/jiti). `index.ts` holds the pi wiring (events, scheduler, commands, rendering); `utils.ts` holds the pure logic (decision parsing, payload merge) with tests in `utils.test.ts`.

Smoke-test the delivery pipeline with the hidden diagnostic lenses: `/hydra-lens test` forces a `queue` decision, `/hydra-lens test-interrupt` forces an `interrupt`. They are one-shot: after firing once, the lens reverts to the last product lens. That revert is load-bearing. A forced interrupt injects a user message, which starts a run, whose run-end observation would otherwise interrupt again, forever.

## Verifying cache parity

```bash
# In an active pi session running hydra:
/hydra-debug        # toggles dumping
# do some work
/hydra-debug        # toggles off
# inspect:
ls /tmp/hydra-debug-*/
# diff a driver payload against its observer payload:
jq -S 'del(.messages[-1])' /tmp/hydra-debug-*/hydra-driver-*.json > /tmp/drv.json
jq -S 'del(.messages[-1])' /tmp/hydra-debug-*/hydra-observer-*.json > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json   # expected: empty (driver and observer share identical prefix)
```

## Compared to the archived andon (bash) version

hydra began as [andon](../archive/README.md), a bash and tmux contraption around Claude Code. The design deltas:

| | andon (bash, archived) | pi-hydra |
|---|---|---|
| Cache parity | 8 normalization rules in `andon-cache-fix.mjs` patching `globalThis.fetch` | byte-true replay via `before_provider_request` capture + `complete()` `onPayload` override |
| Driver inheritance | `claude --resume <id> --fork-session --print` subprocess | `complete()` SDK call from inside the driver process |
| Observer state | JSON file in `~/.local/state/andon-observer/` | session custom entries via `pi.appendEntry("hydra-call", ...)` |
| Delivery | `tmux send-keys` | `pi.sendMessage` / `pi.sendUserMessage` |
| Polling | JSONL mtime watch loop | driver commit events (`message_start`) + `agent_end` |
| Self-feedback prevention | `recent_decisions` injected into prompt (caused hallucination loops) | delivered-set dedup; queued feedback becomes part of the replayed context by design, since the observer sees exactly what the driver sees |
| Status display | none / external log | TUI footer with live hit ratio + cost |
