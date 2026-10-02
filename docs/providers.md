# Providers and measurements

This is the canonical reference for pi-hydra's provider behavior, measured model coverage, cache economics, dated results, volatility caveats, and evidence links. The [README](../README.md) explains the product; [Architecture](architecture.md) explains the provider-neutral system.

All numbers here describe measured regimes, not universal surcharges or timeless backend constants. Re-run the probes after Pi or provider changes.

## Supported provider boundary

Observation is enabled only for provider/API pairs whose replay safety and cache behavior have been measured:

- Anthropic with `anthropic-messages`;
- OpenAI Codex with `openai-codex-responses`, validated on GPT-5.6;
- OpenAI's official `openai-responses` endpoint with ChatGPT OAuth sign-in, tested on GPT-6.1 Sol;
- the local [pi-ds4](https://github.com/mitsuhiko/pi-ds4) provider with `openai-responses` (its default protocol), tested on DeepSeek V4 Flash.

Older Codex and other ChatGPT models pass their respective runtime gates but their cache economics are unvalidated, as do the other models pi-ds4 serves (DeepSeek V4.1, V4 Pro, GLM). pi-ds4's other protocols stay disabled. The OpenAI API-key path shares serializer code but remains disabled until measured. Other pairs warn once and skip observation rather than risk full-price replay or driver breakage.

Heads always use the driver's model, tool schemas, and thinking configuration. Prompt caches are model-specific; choosing another model would forfeit the shared prefix. Replaying the captured request is not enough for thinking effort: on Anthropic models with mid-conversation effort, pi-ai sets the effort in a `system` message at the end of each request, and the head's own call writes the one at the end of its request. The merge therefore gives the head's effort messages the effort the captured request ends with, so the captured request decides, even if the setting or the model changed since. Hydra captures the request in its own `before_provider_request` handler: edits by extensions whose handlers run earlier are included, edits by handlers that run after Hydra's are not, for the effort as for the rest of the replay. That message comes after the cached prefix, so it costs no cache reads.

## Provider lifecycle

### Mid-run

hydra captures the driver's request in `before_provider_request` and schedules after the response begins at `message_start`.

On Anthropic, probes verified that the cache entry becomes readable at response start with no distinguishable propagation delay: commit+0 observations on Haiku and Fable, with and without thinking, read the committed prefix. A mid-run observation therefore keeps the captured prefix byte-identical and appends only its fresh handoff.

OpenAI Codex and ChatGPT sign-in use the same lifecycle trigger, but commit/read timing is looser. An observation reads whatever has committed and may pay the uncached remainder. Codex backend observations in July 2026 ranged from near-instant in full-stack traffic to a controlled read becoming available within 65 seconds; timing changes economics, not delivery safety.

ds4 runs one request at a time on one GPU. A head's request sent while the main assistant's reply is streaming waits until that reply ends, and the main assistant's next request waits behind the heads' requests. See [ds4](#ds4) for what that costs.

The first response of each run is skipped unconditionally. On later runs, the previous run-end observation covered the preceding state; in a fresh session, the first review arrives at an eligible later snapshot or at run end.

### Run end

The assistant response a request produces is not part of that request's prompt-cache input. At `agent_end`, hydra therefore carries the final assistant message M into the observation through Pi's own provider serialization.

On Anthropic, hydra moves the driver's deepest message-level cache marker, including its TTL, onto M's last markable block. With the five-minute marker used in the retained measurements, M changes from fresh input at 1.0× to a cache write at 1.25×, a 0.25× premium; the driver's next turn then reads it at 0.1× instead of writing it at 1.25×, a 1.15× saving—the roughly 5:1 pre-warm bet. A one-hour marker has a different write premium, so current economics depend on the driver's retention setting. Human latency is normally longer than observation TTFT, so M is usually warm before the next prompt.

On both OpenAI routes, the merge is marker-free and implicit caching controls the frontier. When the backend reads the cached prefix, the run-end observation pays the newest turn plus its observer tail; on a miss it can pay for the entire context. Do not apply Anthropic's explicit pre-warm accounting to either route.

M is selected by identity: hydra records the response message's own timestamp at `message_start` and requires an exact match at run end. Wall-clock comparisons lost M nondeterministically in same-millisecond measurements. Errored or aborted final requests correctly attach nothing.

## Provider payload mechanics

### Anthropic

The captured content prefix is cloned and the observation tail is appended. For a plain mid-run handoff, no cache marker moves. At run end, the deepest message-level marker moves onto M. During an acting loop, it advances to the tail's last markable block, so each loop turn is written once and read on later iterations. Loop markers are plain ephemeral markers rather than the driver's longer TTL.

Only text, `tool_use`, and `tool_result` blocks can carry the marker; thinking blocks cannot. The merge relocates an existing breakpoint rather than adding a fifth one beyond Anthropic's four-breakpoint request budget.

Anthropic receives one combined user handoff. In a July 2026 A/B, a separate system envelope tied review accuracy at 64.4%, reduced parse validity from 100% to 96.7%, helped Opus but regressed Sonnet, and added 744 ms mean latency. A model-specific capability gate was rejected, so all Anthropic models keep the combined form.

### OpenAI Codex

The merge appends Pi's serialization of `[M?, user lens, loop turns…]` to the captured `input`, then inserts Hydra's stable developer envelope immediately after the user lens. It touches no other captured field and removes explicit prompt breakpoints from the tail because this backend uses implicit caching.

A combined-user treatment was also entitlement-unsafe: after included quota was exhausted, all 24 final-candidate combined-user calls failed with `The usage limit has been reached` while adjacent user-lens-plus-developer-envelope controls succeeded. The split form is both the measured higher-quality protocol and the safe route for that backend.

The first developer-envelope treatment cut extra observer turns from 67 to 3 while preserving total-loop cache hit (83.07% versus 83.30%). Review-action accuracy rose from 72.2% to 84.4%; after the generic envelope was tightened so the lens alone controls scope and intervention, a fresh treatment reached 98.9% (88/89 API-successful calls) versus 72.2% for saved controls. Two blinded judges preferred treatment 62 times, control 15 times, with 103 ties.

### ChatGPT sign-in

The new `openai-responses` route uses the same append-only `input` merge as Codex, but only with OpenAI's official endpoint and an active OAuth login. It checks the resolved credential before dispatch and again between acting-head turns; a switch to an API key stops the observation. Its observation also passes the driver's session ID to Pi AI: copying `prompt_cache_key` in the body without the corresponding session routing header measured zero cache reads in a repeated session; with the session ID, the same probe read 1,792 tokens. Heads with and without tools get the split handoff described below.

An October 1, 2026 GPT-6.1 Sol OAuth smoke test produced a real arithmetic finding delivered to the user, and an acting head read a file and completed via the `hydra` tool. Cache reads varied: one fresh-session judge observation read 1,664 tokens of its 2,274-token input, while other fresh-session observations read zero. In a continued session, judge observations read 1,792 tokens of 2,385 total, and an acting head read about 69% of its first call's input. The 1,664-read judge cost $0.00190 with zero cache writes; another fresh noop with zero cache reads or writes cost $0.00492. These are different prompts, not a controlled savings estimate. **Cache savings on a fresh observation are not guaranteed.** These few calls establish that reuse is possible, not a stable cost target; `/hydra-stats` and the footer grade it against the default 97% band and label the target "not calibrated".

Heads without tools get Codex's split handoff here too: the head's instructions in a user message, Hydra's rules in a developer message right after it. Measured October 2, 2026 on GPT-6 models (astra, sol, luna, 6.1-sol; gpt-6-terra is not available with a ChatGPT login) at low, medium and high effort, on both OpenAI routes: one arithmetic head and a transcript whose tool returned a wrong product, 3 wrong-answer and 2 correct-answer calls per cell, 240 calls sent through pi-ai with pi-hydra's own handoff builders and merge, scored with Hydra's `classifyJudgeResponse`. A catch had to be a valid finding for the main assistant naming the correct product. The split caught 66 of 72 wrong answers, with no false alarm and no rejected answer. The combined message caught 34 of 72, and Hydra rejected 51 of its 120 answers because the head called the main assistant's tool instead of answering (mostly gpt-6-astra and gpt-6.1-sol, at every effort). Single cells are small: gpt-6.1-sol at low effort caught 1 of 3 with the split on this route. Script and full replies: [experiments/split-handoff.mjs](../experiments/split-handoff.mjs), [split-handoff-2026-10-02.jsonl](../experiments/split-handoff-2026-10-02.jsonl).

Heads with tools get the same split. This is a transfer, not a measurement on this route: the July developer-envelope results on Codex above are for heads without tools, the July acting study below measured the acting design that splits on Codex together with contract changes, and the judge-head result here shows the same effect on both OpenAI routes. A smoke run confirmed the path works: on October 2, 2026, an acting head on gpt-6-astra through pi read a file with its `read` tool, finished through `hydra` and steered ([record](../experiments/split-handoff-acting-smoke-2026-10-02.jsonl)).

In four live sessions on October 2, 2026 with GPT-6 Luna (two per OpenAI route, navigator and simplifier heads), a judge head still requested a tool in 1 of 29 checks, on Codex, with the split.

### ds4

pi-ds4 runs [antirez/ds4](https://github.com/antirez/ds4) locally and speaks `openai-responses`. The merge is the same append-only `input` merge as on the other OpenAI routes, with no session ID: ds4 matches requests by their content, and its server reuses the longest prefix it still holds in memory or in its disk cache. Calls cost $0, and Hydra leaves the credential to pi-ds4.

Heads get Anthropic's form: one combined user message, with and without tools, and heads with tools finish with a JSON decision. ds4 builds the DeepSeek V4 Flash prompt by moving every system and developer message to the top (`render_deepseek_chat_prompt_text` in `ds4_server.c`), so the split form's developer message makes a head's prompt stop matching the main assistant's right after the system prompt. Measured October 2, 2026 (pi 1.0.0, pi-ds4 `db8806c`, ds4 `0aaea5a`, DeepSeek V4 Flash Q2, Apple M4 Max 128 GB), same coding task, navigator and simplifier heads without tools, each run starting with an empty ds4 disk cache:

| Form | Read from cache per check | Prefilled per check | Hit ratio | Head requested a tool |
|---|---|---|---|---|
| Combined (5 turns) | 10,710 → 11,803 tokens, growing with the conversation | about 470–1,030 tokens: its instructions plus the few tokens since ds4's last saved point | 91.2–96.2%, steady | 0 of 12 checks |
| Split (3 turns) | 10,709 tokens every time: the system prompt only | its instructions plus the conversation so far: 852 → 1,804 tokens | 92.6% → 85.6% | 4 of 8 checks |

An earlier, longer run without emptying the cache first showed the same split pattern over 16 turns (prefill 671 → 4,204 tokens, hit ratio down to 72%, a tool requested in 23 of 34 checks); its combined counterpart ran into a full disk cache (see [Provider limits](#provider-limits)) and is not comparable.

## Completion channels

Heads without tools return the same [findings JSON](heads.md#decisions-when-findings-land) on all supported routes. See [Delivery](architecture.md#delivery) and [Failed checks](architecture.md#failed-checks) for what happens to their answers.

Heads with tools finish differently:

- **OpenAI Codex and ChatGPT sign-in:** call `hydra` once with `complete_observation`. Hydra rejects a completion call if there are other tool calls in that turn.
- **Anthropic and ds4:** return a short JSON decision after the tool work, with `action: "noop"` when there is nothing to report. On Anthropic, finishing through a tool call measured slower and more expensive; ds4 uses Anthropic's form for the cache reason in [ds4](#ds4).

A head added with `ends_when` reports that its condition is met with `done: true` in `complete_observation`, or `"done": true` in its JSON decision or findings.

On all supported routes, heads use real tools for work and head management. A head that successfully removes itself is finished; it makes no further completion call. Hydra cannot check whether the head did every intended check.

The measurements below used the July 2026 instructions, before the September wording changes. They do not measure the quality of the current wording.

Across 78 randomized OpenAI acting pairs on Luna, Terra, and Sol, the then-final generic design scored 77/78 (98.7%) versus 63/78 (80.8%), used 201 versus 227 calls, cost $0.7499 versus $0.8330, and reduced mean latency from 7.99 s to 7.10 s. By family: docs 29/30 versus 21/30, tuner 18/18 versus 12/18, foreman 30/30 versus 30/30. A separate frozen foreman screen makes the combined result 45/45 versus 44/45.

The same contracts on Anthropic scored 38/42 versus 31/42 across Sonnet, Opus, and Fable, with seven treatment-only wins, no control-only wins, and four shared misses. Treatment used 112 versus 120 calls, cost $0.7285 versus $0.7782, and reduced mean/p95 latency from 7.37/12.01 s to 7.05/11.67 s. Parse validity was 41/42 versus 42/42.

A final OpenAI completion-transport A/B covered 144 review pairs and 96 acting pairs. Typed completion was valid in 144/144 reviews versus 142/144 for JSON and removed 23 retry turns; semantic review accuracy was 42/144 versus 40/144, mean latency 6.68 versus 6.71 s, and cost was 16.7% higher. Acting accuracy was 95/96 versus 96/96. Terminal self-removal stayed 24/24 while mean latency fell from 5.61 s to 3.09 s. The [experiment log](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/experiments/README.md#enforceable-completion-ab-july-2026) carries the full KPI table.

## OpenAI Codex

### Session sharing

Controlled probes found Codex cache routing strongly session-sensitive. Sharing the driver's provider session reliably co-locates observations with entries the driver wrote; what later calls reuse still depends on the backend's implicit cache behavior. Sharing is structurally safe only when the driver sends full input each turn: Pi transport `websocket` or `sse`.

Under continuation transport such as `auto`, the driver relies on `previous_response_id` bookkeeping in a different Pi AI module instance. An observation sharing that session can evict the referenced response and break the driver's next request (`Previous response … not found`). This reproduced 2/2 under `auto` and 0 times under `websocket`.

hydra pins the initial sharing decision at the first `agent_start`, re-reads transport before every observation, and moves only one way: once sharing becomes unsafe it uses one observer-owned UUIDv7 for the rest of the session. It never upgrades back, because stale continuation state could be resurrected.

### Tripwire

If a driver request ends with the known continuation-error signature, hydra permanently retreats to its own session and, when heads are active, reports why. In-flight acting heads wind down at their next turn boundary. A live-fire July 2026 verification forced unsafe sharing, reproduced one driver failure, observed the permanent retreat, and saw Pi recover on retry. One race remains: a settings flip while a shared observation is in flight may cause one failure before the tripwire acts.

### Backend volatility

Treat these July 2026 observations as dated snapshots:

- Controlled cache entries appeared session-scoped, though full-stack traffic occasionally showed cross-session reads of identical content.
- Read granularity moved from reported 128-token blocks on July 13–14 to 512-token steps in a July 24 Pi 0.82 probe.
- Entry lifetime moved from roughly 2–9 minutes on July 13 to under roughly 85 seconds idle on July 14.
- GPT-5.6 rejected missing/v4 session IDs and SSE on July 13, then accepted them July 14.
- `cache_write_tokens` was never reported on the subscription backend.

hydra's safety does not depend on those values. UUIDv7, websocket observation transport, monotone fallback, and the tripwire remain costless invariants that were required at least once.

## Economics and measurements

### Anthropic cache hit

The handoff is the main fresh input, so hit ratio generally rises with driver context. The former 220-token table was only an illustration for a fixed handoff size; current handoff size varies with mode and delivery context, so measured sessions are the useful reference.

An earlier three-prompt session with four observations measured 97.92% aggregate and $0.0202 total observation cost: 87.79% at a 3.5K cold start, then 98.11%, 99.07%, and 99.12% as context grew. A retained commit-point live E2E on Fable/xhigh measured 7/7 piggyback observations as pure reads with write=0, while each run-end fork wrote exactly M.

Across retained live Anthropic sessions using five-minute cache retention, one always-on head cost 32.5%–61.4% of driver cost. This is a measured historical range, not a fixed surcharge; retention changes the write economics.

### Codex cache hit and cost

Healthy shared-mode Codex observations measured roughly 84%–87% cache hit. A July 2026 live E2E on GPT-5.6 Luna ranged from 87.4% on the first piggyback to 84.1% on the final run-end observation; individual calls cost about $0.0015–$0.0021 and driver cache hit stayed near 87% with no errors.

In the registered production-shaped wave of August 3, 2026, six driver runs compared the then-shipped enumerate-all-findings contract (ENUM) with a single-finding baseline (MAIN). Across cache-comparable observations, MAIN cost $0.0253 per observation and 52.1% of driver cost (103 observations); ENUM cost $0.0356 and 77.0% (108 observations). Including all charged cache misses and calls after failed driver turns raised those ratios to 66.2% and 93.3%. These establish cost only; the quality benchmark was still in progress. See [capstone producer results](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/experiments/OPENAI-CAPSTONE-PRODUCER-RESULTS.md).

### ds4 cache hit and time

Every ds4 call costs $0; the cost is time on the one GPU. In a live session on October 2, 2026 (same setup as [ds4](#ds4), on top of `f97158e`, with pi's codemode tool and three other extensions loaded), 10 of 10 head requests started with the main assistant's exact conversation. Heads without tools read 91.9–96.1% of their input from ds4's cache; a head with tools read 94.0–95.5% on its first turn, hit the cache on its second turn too, and finished with a JSON decision.

The same task took 43 s without Hydra and 137 s with three heads (navigator and simplifier without tools, one head that reads files): 13 checks of 11–42 s each, including time waiting for the GPU. One head sent a steer, and the main assistant took two more turns than without heads. One run each, not a factor: head time grows with how much each head writes, at about 30 tokens per second.

The per-check records of these runs and of the form comparison above are in [`experiments/ds4-heads-2026-10-02.jsonl`](../experiments/ds4-heads-2026-10-02.jsonl).

### Flue agents

[flue-hydra](https://github.com/pandysp/flue-hydra) runs the same heads in Flue agents; its measurements live in its README.

### Interpreting the numbers

An observation can be cheap while an always-on session is materially more expensive: heads observe repeatedly, and multiple heads fan out per trigger. Output volume, task shape, model, reasoning level, provider retention, and cache misses all matter. On subscription Codex, observation spend uses the same account quota as the driver.

`/hydra-stats` is the authority for the current session. The repository [decision table](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/experiments/DECISION-TABLE.md) and [experiment index](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/experiments/INDEX.md) are the durable evidence for published waves.

## Provider limits

- **Anthropic cold start:** the first observation may fall below the 97% target because the handoff is large relative to a tiny initial context.
- **OpenAI commit window:** an observation racing commit may pay its snapshot as fresh input; this degrades economics rather than correctness. ChatGPT sign-in showed fresh-session misses in the October smoke test.
- **Codex fallback:** observer-scoped sessions pay the driver context once and may repay after idle expiry.
- **Headless shutdown:** Pi may exit before a slow run-end observation finishes. `HYDRA_SHUTDOWN_GRACE_MS` defaults to 5 seconds; raise it for headless verification (`0` means do not wait).
- **ds4 runs one request at a time:** heads and the main assistant take turns on one GPU, so every head check adds its own time to the session. Each switch between a head and the main assistant also writes the evicted conversation, about 170 MB, to ds4's disk cache (8 GB by default). In one measurement the cache was already full, and ds4 evicted each new entry before any request reused it: every request, the main assistant's included, re-read about 11,000 tokens.
- **Multi-head run end:** heads run in parallel for low latency. On Anthropic each run-end fork may pay M's write rather than coordinating a follower free-ride; measured contention remained a single-digit share of observation spend.
- **Long tools:** acting heads wind down at turn boundaries, but a long bash execution may outlive shutdown grace.
- **Partial output:** heads judge complete captured requests, never an unfinished generation.
- **Unverified paths:** OpenAI API-key transport, older Codex model economics, models pi-ds4 serves other than DeepSeek V4 Flash, and provider behavior outside the measured pairs remain out of scope.

## Verification procedures

### Cache parity

In an active session:

```bash
/hydra-debug
# perform work
/hydra-debug
ls /tmp/hydra-debug-*/
```

For Anthropic, truncate the observation's messages to the driver's length. The tail is the handoff, M at run end, and on models with mid-conversation effort the empty `system` messages pi-ai adds around them. A mid-run pair must then match exactly:

```bash
DRIVER=/tmp/hydra-debug-<id>/hydra-driver-<stem>.json
OBSERVATION=/tmp/hydra-debug-<id>/hydra-observation-<stem>.json
N=$(jq '.messages | length' "$DRIVER")
jq -S '.' "$DRIVER" > /tmp/drv.json
jq -S --argjson n "$N" '.messages |= .[:$n]' "$OBSERVATION" > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json
```

At run end the driver's last mark moves onto M, so also ignore cache markers:

```bash
N=$(jq '.messages | length' "$DRIVER")
jq -S 'walk(if type == "object" then del(.cache_control) else . end)' "$DRIVER" > /tmp/drv.json
jq -S --argjson n "$N" '.messages |= .[:$n] | walk(if type == "object" then del(.cache_control) else . end)' "$OBSERVATION" > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json
```

For either OpenAI route, truncate observation input to the driver length:

```bash
N=$(jq '.input | length' "$DRIVER")
jq -S '.' "$DRIVER" > /tmp/drv.json
jq -S --argjson n "$N" '.input |= .[:$n]' "$OBSERVATION" > /tmp/obs.json
diff /tmp/drv.json /tmp/obs.json
```

A stricter cross-process Anthropic check runs two headless prompts in one session directory. The second driver's first `cacheRead` should equal the first run's committed prefix plus M, and `cacheWrite` should be approximately the new user prompt:

```bash
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p --session-dir /tmp/v "Explain TCP slow start in 200 words, plain text, no tools."
HYDRA_SHUTDOWN_GRACE_MS=120000 pi -p -c --session-dir /tmp/v "Thanks. One sentence: what is the congestion window?"
jq -r 'select(.type=="message" and .message.role=="assistant") | .message.usage | [.cacheRead, .cacheWrite, .output] | @csv' /tmp/v/*.jsonl
```

### Verifying the Codex tripwire

This intentionally breaks one request. Use only a throwaway session:

```bash
cd /tmp/scratch-project
HYDRA_UNSAFE_FORCE_SHARE=1 pi --model openai-codex/gpt-5.6-luna
```

1. Turn 1 lets observations share the driver's session unsafely.
2. Turn 2 should fail once with `Previous response … not found`; the warning announces permanent retreat and Pi's retry recovers.
3. Turn 3 onward should observe in Hydra's own scope with no repeated driver failure.

The unsafe flag skips only the transport gate; monotone state and the tripwire remain active.
