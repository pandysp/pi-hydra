# andon for pi

> Pull the cord on bad AI code — fork-per-turn observer as a [pi](https://pi.dev/) extension.

This is the principled reimplementation of [andon](../README.md). The bash version reverse-engineered Claude Code's prompt construction pipeline and patched `globalThis.fetch` via `NODE_OPTIONS` to keep the observer fork in cache parity with the driver. None of that is needed in pi — `before_provider_request` gives us the driver's exact provider payload as a first-class hook.

## What it does

After every driver turn, andon clones the driver's exact provider payload (system prompt, tools, message history, thinking config, cache_control markers — all of it), appends a single `<system-reminder>`-wrapped user message asking for a JSON observer decision, and replays it through the same model. Observer responds with `noop`, `queue`, or `interrupt`. Routed via pi's existing message-injection primitives.

```
turn N completes
  ↓
turn_end event
  ↓
clone last captured payload
append: { role: "user", content: <observer prompt> }
  ↓
complete() with onPayload override → byte-true replay
  ↓
parse JSON decision
  ↓
noop      → log only
queue     → pi.sendMessage({ deliverAs: "followUp" })
interrupt → pi.sendUserMessage({ deliverAs: "steer" })
```

Same model, same system prompt, same tools, same thinking config — only an extra user message at the end. Cache hit ratio is determined by the size of the observer prompt (~149 tokens) relative to the driver context.

## Cache hit ratio (the load-bearing metric)

| Driver context | Observer prompt | Theoretical hit |
|---:|---:|---:|
| 4K | 149 | 96.4% |
| 10K | 149 | 98.5% |
| 30K | 149 | 99.5% |
| 100K | 149 | 99.85% |

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

Cold-start observations are bounded by tiny initial context. Once any conversation history exists, every subsequent observation hits 97%+. Aggregate over any non-trivial session converges above the 97% target.

## Installation

```bash
# Clone andon
git clone https://github.com/pandysp/andon ~/projects/andon

# Symlink the pi extension into pi's auto-discovery path
ln -s ~/projects/andon/pi ~/.pi/agent/extensions/andon
```

Verify:

```bash
pi --help 2>&1 | grep andon
# (no output expected; commands appear inside pi only)

pi  # start interactive
# Type /andon-stats — should show "no observations yet"
```

## Commands

- `/andon` — toggle observer on/off
- `/andon-lens <quality|security|simplifier|api-design>` — switch lens
- `/andon-delivery <print|queue|interrupt>` — switch delivery mode
- `/andon-stats` — show cumulative metrics + recent decisions
- `/andon-debug` — toggle dumping driver/observer payloads to `/tmp/andon-debug-<ts>/` for `jq diff`-ing

Status footer always visible:
```
andon:quality print hit 98.5% (last 99.1%) $0.0234 (12 obs)
```
Footer turns yellow at <97%, red at <90%.

## Delivery modes

- **`print`** (default, safe): observer decisions appear as custom-rendered `andon-feedback` messages in the TUI but are NOT injected into the driver's context. You see what the observer would have said. Use this until you trust the lens.

- **`queue`**: observer decisions are injected via `pi.sendMessage({ deliverAs: "followUp" })`. They appear after the agent finishes its current tool batch and become part of the next driver turn's context.

- **`interrupt`**: observer `interrupt` decisions are injected via `pi.sendUserMessage({ deliverAs: "steer" })` — they preempt and become the next thing the driver sees. `queue`-typed decisions still go through `followUp`.

## Lenses

Ported from [`../lenses.md`](../lenses.md). Quality, security, simplifier, api-design — same prompts, same boundaries.

## What's deliberately different from the bash version

| | bash andon | pi andon |
|---|---|---|
| Cache parity | 8 normalization rules in `andon-cache-fix.mjs` patching `globalThis.fetch` | byte-true replay via `before_provider_request` capture + `complete()` `onPayload` override |
| Driver inheritance | `claude --resume <id> --fork-session --print` subprocess | `complete()` SDK call from inside the driver process |
| Observer state | JSON file in `~/.local/state/andon-observer/` | session custom entries via `pi.appendEntry("andon-call", ...)` |
| Delivery | `tmux send-keys` | `pi.sendMessage` / `pi.sendUserMessage` |
| Polling | JSONL mtime watch loop | `turn_end` event |
| Self-feedback prevention | `recent_decisions` injected into prompt (caused hallucination loops per andon README) | `customType: "andon-feedback"` filter (clean) |
| Status display | none / external log | TUI footer with live hit ratio + cost |

## Cache propagation race & the adaptive delay

The driver's API call writes new cache entries when its prefix grows (typically the
first turn after a tool call within a prompt). Anthropic's write-to-read propagation
has a brief lag (~hundreds of ms). When the observer fires automatically immediately
after `turn_end`, those just-written entries can be missed — cacheWrite=1KB,
hit drops to ~80%.

`/btw` doesn't see this race because it fires when the user types `/btw <question>` —
seconds of human typing latency is orders of magnitude longer than the propagation lag.
We fire automatically, so we'd race.

The fix exploits something `/btw` doesn't have: in-process access to the driver's
AssistantMessage. After `turn_end` we read `event.message.usage.cacheWrite`. If it's
> 200 tokens, the driver just wrote new cache and we wait 500ms before observing.
Otherwise we fire immediately.

Verified end-to-end: 0 racy observations across 9-call mixed-load test, 98.47%
aggregate hit. Single-turn prompts incur no observer delay; only multi-turn
tool-using prompts pay the 500ms once.

## Limitations & roadmap

**Anthropic-only for v0.1.** The capture/replay pattern requires the provider to support prompt caching with explicit `cache_control` markers, which we've validated only on Anthropic's Messages API. OpenAI, Google etc. would either need their own cache markers or fall through to no-cache (still works, but expensive). Detected at runtime — andon skips observation with a footer warning if the driver is on a non-Anthropic provider.

**Cold-start observation is below 97%.** The first observation in a fresh session has a small driver context that the observer prompt nearly equals in size. We accept this — the metric converges fast once any history exists.

**Print mode may drop the final observation.** In `pi -p`, the process exits when the agent finishes, and a fire-and-forget observer started on the last `turn_end` may not complete before exit. Interactive mode is unaffected. Future fix: await one in-flight observer on `session_shutdown`.

**Single lens at a time.** Multi-lens parallel observation (`quality + security + simplifier` simultaneously) is straightforward to add — fan out from `turn_end` into N parallel `complete()` calls — but not in v0.1. Each adds ~$0.005 + ~150 input tokens.

**No hard mid-stream cancellation.** The bash version of andon used `tmux send-keys Escape` to cancel an in-flight Claude Code stream, then inject. pi's equivalent (`pi.sendUserMessage` with `deliverAs: "steer"`) is softer: it queues the message until the current turn's tool calls finish, then injects it as a real user message between turns of the same agent run. Verified: the driver receives the steered message mid-multi-turn and responds to it. But a *single* long-running LLM call (assistant generating 10K tokens of output) cannot be interrupted by the observer in the current architecture, because we observe on `turn_end` (after the call settles, with a stable payload for cache-true replay). True mid-stream cancellation would require a separate observer flavor subscribing to `message_update` events, reasoning over partial output, and calling `ctx.abort()` — with no cache parity since the payload is mid-flight. Future work.

## Development

```bash
cd ~/projects/andon/pi
# Edit index.ts
# Reload pi (Ctrl-R or /reload) to pick up changes
```

The extension is a single file (~470 lines) with no build step — pi loads `.ts` via [jiti](https://github.com/unjs/jiti).

## Verifying cache parity

```bash
# In an active pi session running andon:
/andon-debug        # toggles dumping
# do some work
/andon-debug        # toggles off
# inspect:
ls /tmp/andon-debug-*/
# diff a driver payload against its observer payload:
jq -S 'del(.messages[-1])' /tmp/andon-debug-*/andon-driver-*.json > /tmp/drv.json
jq -S 'del(.messages[-1])' /tmp/andon-debug-*/andon-observer-*.json > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json   # expected: empty (driver and observer share identical prefix)
```
