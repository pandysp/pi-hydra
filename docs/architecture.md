# Architecture

How hydra observes a pi session at prompt-cache prices. For the what and why, start with the [root README](../README.md); the empirical basis for everything here is [`../experiments/`](../experiments/README.md).

## Commit-point observation

hydra replays the driver's exact provider payload with one observer prompt appended. Because the prefix is byte-identical, every observation is a prompt-cache read of the entry the driver itself just wrote. Observations fire at the driver's own cache commit points, on two triggers:

**Piggyback (mid-run).** When a driver response begins streaming (`message_start`, the moment Anthropic's cache entry becomes readable; commit+0 free rides verified), hydra replays that request's captured payload plus an observer prompt. The driver just paid the cache write, so the observation is a pure cache read, includes the latest assistant message and tool results, and its decision typically lands while the driver's response is still streaming.

**Run-end (agent_end).** When the agent hands control back to the user, no next driver request will carry the final assistant message M into the cache, so hydra forks from n: it hands M to the observer's `runAgentLoop` call so pi-ai's own provider code serializes it (thinking blocks, signatures, surrogate sanitization; parity by construction rather than by mirroring), then the `onPayload` hook splices that output onto the captured prefix and moves the driver's message-level cache marker (TTL included) onto M's last markable block (text or tool_use), staying inside the 4-breakpoint budget. The observer pays M's write once (1.25×) and pre-warms the driver's next turn, which reads M at 0.1×: a ~5:1 bet that lands because human latency far exceeds observer TTFT.

```
mid-run:  request N+1 dispatched ─► payload captured
          response N+1 begins    ─► PIGGYBACK: replay payload + prompt (pure read)
run end:  agent_end              ─► RUN-END: payload + M(marker) appended (fork-from-n)
  ↓
runAgentLoop(); onPayload splices pi-ai's own serialization onto the captured bytes
  ↓
parse JSON decision
  ↓
noop      → log only
print     → pi.sendMessage (renders in the TUI, never enters the agent's context)
queue     → pi.sendMessage({ deliverAs: "followUp" })
steer     → pi.sendUserMessage({ deliverAs: "steer" })
interrupt → ctx.abort() + pi.sendUserMessage({ deliverAs: "followUp" })
```

Same model, same system prompt, same tools, same thinking config; the only difference is one extra user message at the end. Cache hit ratio is determined by the size of the observer prompt (~220 tokens) relative to the driver context.

Observations run through a conflating single-slot scheduler, per head: every head has at most one observation in flight and one waiting slot that a newer snapshot overwrites, and an in-flight observation always runs to completion. Staleness is bounded to one cycle because the slot always holds the newest snapshot. The granularity is per head rather than one global batch so an acting head's minutes-long tool loop cannot starve the judging heads, and a head that is busy through a commit point still reviews the newest snapshot the moment it frees up.

## Heads are files

A head is fully defined by one markdown file ([`heads.md`](heads.md) has the format). Discovery reads `~/.pi/agent/hydra` and the nearest ancestor `.pi/hydra`, project shadowing user, fresh at every `agent_start` and every `hydra` tool call; a vanished file prunes its head from the active set with a notice rather than observing with a ghost. The active set is the one piece of state not on disk: it persists as `hydra-config` session entries, restored on resume and branch navigation. At session start the precedence is an explicit `--hydra-heads` flag (present intent), then the saved set (recorded intent), then the files' `autostart` markers (the cold-start default, deliberately not persisted so a resumed session re-reads the files). There is no delivery setting anywhere: a decision's force is the head's own choice, shaped by its instruction.

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

M's serialization is parity by construction: the observer hands M to its `runAgentLoop` call, and the `onPayload` hook splices pi-ai's own provider output onto the captured prefix. The fork's bytes match the driver's next request through the exact code path that will produce it, including surrogate sanitization and the dropping of aborted or errored messages. There is no hand-maintained mirror to drift when pi-ai changes.

Selecting M is identity matching, not clock comparison. pi constructs the response message about a millisecond before `before_provider_request` fires, so the original `timestamp >= capturedAtMs` check was a same-millisecond coin flip that silently dropped M on the losing side (measured: -1ms, 0ms, -1ms across three runs). hydra now records the response's own timestamp at its `message_start` and attaches M only when it matches; the stale cases (errored or aborted final request) fall out exactly, because no response started and there is nothing to match.

Verified end-to-end in June 2026, cross-process (stricter than the normal in-session case, since the session is re-serialized from disk): the piggyback observation was a pure cache read (read 4995, the full committed prefix, write 0); the run-end fork wrote exactly M (342 tok); and the driver's next first request read prefix+M to the token (5337 = 4995 + 342), writing only its new user message (25 tok). Re-verify after pi upgrades with two headless runs. The second run's first `cacheRead` must equal run 1's total (prefix + M), and its `cacheWrite` must be about the new prompt, not about M:

```bash
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p --session-dir /tmp/v "Explain TCP slow start in 200 words, plain text, no tools."
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p -c --session-dir /tmp/v "Thanks. One sentence: what is the congestion window?"
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.usage | [.cacheRead, .cacheWrite, .output] | @csv' /tmp/v/*.jsonl
```

## Acting heads

By default a head may run tool calls before its decision; a head file's `tools:` frontmatter narrows the executable set, down to `[]` for a judge-only head (a hard no-tools wrapper and the snappy single-call path). The mechanism extends the replay, it does not replace it:

**The loop is pi's own, and it is the only path.** Every observation runs `runAgentLoop` from pi-agent-core (a first-class extension import; the loader aliases it in both bundle modes) rather than a hand-rolled imitation: argument validation, "tool not found" error results, parallel-vs-sequential execution policy, and abort discipline stay pi's code and evolve with it. A judge-only head is not a separate code path, just the zero-tool case: it answers in one turn and the loop exits, one provider call exactly like a bare `complete()`. The same reuse philosophy as M's serialization: run the real thing instead of mirroring it.

**Every loop call replays the captured prefix.** The loop's own built context is discarded by the `onPayload` merge, so iteration N's request is the byte-true driver prefix plus the observer's tail (`[M?, prompt, turn 1, results 1, ..., turn N-1]`). The driver prefix stays a pure cache read on every iteration; measured live, read stayed at the full committed prefix while only tail content was written.

**Tool parity comes from the replay itself.** The model can only call tools in the replayed payload's tools array, which is the driver's active set by construction. hydra executes the seven standard tools (constructed from pi's exported factories at the driver's cwd) plus its own `hydra` tool, filtered down to the head file's `tools:` list when one is given; a call outside the list, or to anything hydra cannot execute (another extension's tool, MCP), gets pi's standard error result and the head proceeds to its decision. write/edit serialize same-file mutations through pi's process-wide queue, shared with the driver because the loader aliases pi-coding-agent to its bundled instance.

**The cache marker advances with the loop.** Cache writes happen only at explicit breakpoints, the budget is four per request, and the driver's payload already spends all four, so the merge only ever moves the deepest message-level marker: onto M for a run-end fork's first call (the pre-warm bet, unchanged), then onto the tail's last markable block once loop turns exist. Each loop turn is written once (plain ephemeral, deliberately without the driver's TTL: the next iteration is seconds away) and read thereafter, instead of re-paid as input every iteration. The prefix+M entry from the first call keeps serving the driver. Anthropic's serving stack was also observed auto-extending entries to the last assistant block on this traffic class without any marker; the explicit advance reproduces those economics within documented semantics instead of relying on the observation.

**Loops are guarded, not budgeted.** There is no cost ceiling; the only bound is a correctness guard: a loop that has not produced a decision after 25 model turns is wound down as a `noop` with a warning, and removing the head from the active set mid-loop winds it down at the next turn boundary. Stats record one `hydra-call` per observation with usage summed across iterations; the hit ratio is taken from the first call alone, since it is the replay-parity signal and later iterations legitimately pay the tail as fresh input.

**File writes are announced.** Every successful write/edit queues a one-line `hydra-feedback` note (`[docs] wrote docs/notes.md`): provenance, not a finding, so the driver is never surprised by files changing under it. Writes inside the observer's bash commands are invisible to this; the authoring guidance in [`heads.md`](heads.md) says to keep bash read-only mid-run.

**Decisions from stale snapshots cannot pull the cord.** An acting head can finish its loop minutes after its snapshot was captured. If the driver has moved on to a newer request, an `interrupt` decision demotes to `steer`: a wrong demotion costs one turn of latency, a wrong abort destroys in-flight work.

## Limitations & roadmap

**Anthropic-only for v0.1.** The capture/replay pattern requires the provider to support prompt caching with explicit `cache_control` markers, validated so far only on Anthropic's Messages API. OpenAI, Google etc. would either need their own cache markers or fall through to no-cache (still works, but expensive). Detected at runtime: hydra skips observation, with a one-time warning, when the driver is on a non-Anthropic provider.

**Acting heads cannot be hard-aborted mid-tool.** The lifecycle abort signal reaches the loop at turn boundaries and tool executions receive it, but a long-running bash command started by an observer runs to completion on shutdown grace expiry. Known limitation, accepted for now.

**Cold-start observation is below 97%.** The first observation in a fresh session has a small driver context that the observer prompt nearly equals in size. Accepted; the metric converges fast once any history exists.

**Headless (`pi -p`) may truncate the run-end observation.** The process exits shortly after `agent_end`; `session_shutdown` awaits the in-flight observation up to 5s, which slow models (fable/xhigh: 10s+) can exceed. Raise via `HYDRA_SHUTDOWN_GRACE_MS` for headless use (`0` means exit without waiting). Interactive mode is unaffected; the observation completes while you read the response.

**Multi-head fan-out is latency-first.** The active head set fans out one observation per head, in parallel, per trigger. Mid-run this is free beyond the prompts, since every head is a pure cache read of the same committed prefix. At run-end the markered forks race and each pays M's write (~$0.01–0.02 per head on fable, measured); the experiments README documents a message_start-coordination pattern that would let followers free-ride on the first fork's write, deliberately not implemented because the contended amount stays a single-digit percent of observer spend and feedback latency is the product metric.

**Decisions judge committed snapshots, not in-flight output.** Interrupt does cancel: an `interrupt` decision calls `ctx.abort()` on the in-flight run and the finding opens the next one, matching the archived bash version's Escape-then-inject behavior. Steer is the softer rung: the message waits for the current turn's tool calls to finish, then lands between turns of the same run, and the piggyback timing means decisions often arrive while a response is still streaming, in time for the very next turn boundary. What remains future work is judging *partial* output: every decision is formed from a committed request snapshot, so a single long-running LLM call is never evaluated mid-generation. That would require reasoning over `message_update` deltas, with no cache parity since the content is mid-flight.

## Development

```bash
cd pi-hydra
npm install        # dev tooling only; users installing the extension inherit nothing
npm run check      # tsc --strict
npm test           # vitest on the pure helpers
# Edit index.ts / utils.ts, then reload pi (Ctrl-R or /reload) to pick up changes
```

There is no build step; pi loads `.ts` via [jiti](https://github.com/unjs/jiti). `index.ts` holds the pi wiring (events, scheduler, commands, rendering); `utils.ts` holds the pure logic (decision parsing, payload merge) with tests in `utils.test.ts`.

Smoke-test the delivery pipeline with the hidden diagnostic heads: `/hydra-heads test` forces a `queue` decision, `/hydra-heads test-interrupt` forces an `interrupt`. They are one-shot: after firing once, the set reverts to the last product heads. That revert is load-bearing. A forced interrupt injects a user message, which starts a run, whose run-end observation would otherwise interrupt again, forever.

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
| Cache parity | 8 normalization rules in `andon-cache-fix.mjs` patching `globalThis.fetch` | byte-true replay via `before_provider_request` capture + `onPayload` override on the observer's own provider call |
| Driver inheritance | `claude --resume <id> --fork-session --print` subprocess | `runAgentLoop` call from inside the driver process |
| Observer state | JSON file in `~/.local/state/andon-observer/` | session custom entries via `pi.appendEntry("hydra-call", ...)` |
| Delivery | `tmux send-keys` | `pi.sendMessage` / `pi.sendUserMessage` |
| Polling | JSONL mtime watch loop | driver commit events (`message_start`) + `agent_end` |
| Self-feedback prevention | `recent_decisions` injected into prompt (caused hallucination loops) | delivered-set dedup; queued feedback becomes part of the replayed context by design, since the observer sees exactly what the driver sees |
| Status display | none / external log | TUI footer with live hit ratio + cost |
