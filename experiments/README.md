# Cache experiments

Empirical verification of Anthropic prompt-cache behavior around the "latest
assistant message": the rationale behind hydra's original n-1 fork heuristic,
and the economics of replacing it with fork-from-n. Run June 2026 on
`claude-haiku-4-5` via OAuth (pi credentials), non-streaming Messages API.

## Scripts

| script | question |
|---|---|
| `cache-latest-message.mjs` | Is the driver's latest assistant message M cached after the driver's own turn? What do n-1 vs n forks cost, serial and parallel? |
| `cache-timing.mjs` | When does a cache write become readable: at writer ingestion, mid-processing, or response completion? |
| `cache-stagger.mjs` | 4 forks, one writer at t=0, three delayed by `--stagger-ms`: do the delayed ones free-ride? `--m-words` scales M, `--thinking` enables adaptive thinking, `--stagger-from commit` anchors the stagger on the writer's `message_start` |
| `cache-thinking-walkback.mjs` | Does a driver-shaped next request (marker only on its own new user message, none on M) find the observation's prefix+M entry via breakpoint walk-back when M carries thinking blocks? |
| `cache-automatic.mjs` | Does automatic caching (top-level `cache_control`) cache the generated response? (No.) |

`lib.mjs` holds the shared harness: OAuth, padding, the Messages call, and
cold-start guards. Every script takes `--model` and `--padding-sentences`
(default 100 sentences ≈ 6.5K tokens, above Haiku 4.5's 4096-token cache
minimum; fable's is 512).

All scripts read the OAuth token from `~/.pi/agent/auth.json` in-process
(never printed) and mimic Claude Code, which the token is gated to: Bearer
auth, the claude-code/oauth beta headers, the CC user-agent, and the CC
identity as the first system block. Each run weaves a unique nonce into every
padding sentence, so runs start cold and cannot satisfy each other's lookups;
the scripts hard-fail if a cold start shows any cache read.

## Findings

### 1. M is not cached after the driver's turn (H1 ✅)

M was only ever a *response*; cache entries are created from *request*
prefixes. An n-fork without a marker paid exactly M's size in uncached input
(input 383 vs 119 for n-1; M = 263). The driver's own call never caches its
own output.

This also holds under automatic caching (top-level `cache_control`): the
auto-breakpoint lands on the last block of the *request*, never the response.
Verified by `cache-automatic.mjs`, where a probe after an automatic-caching
request read exactly the request-sized prefix and paid the write for M
(write ≈ M + followup, twice reproduced: 184≈174+10, 173≈163+10). The docs'
multi-turn table says the same: Asst(2) is written by request 2, not by the
request that generated it.

### 2. n-1 forks are pure cache reads, even ×3 parallel (H2 ✅)

write=0, read=full prefix, input ≈ observation prompt (~119 tok) for all three
simultaneous n-1 forks. This was the original hydra behavior: cheap, but it
judges a stale snapshot (the cause of the stale-review bug).

### 3. A marker on M creates a readable prefix+M entry (H3 ✅)

First fork pays cache_creation ≈ M (1.25×); a later serial fork reads it
(0.1×). Marker placement doesn't matter for lookup: a driver-shaped request
(marker only on its own new user message) finds the prefix+M entry via
breakpoint walk-back. An observation fork-from-n with a marker on M therefore
pre-warms the driver's next turn.

### 4. Write commit is at TTFT ("once the response begins")

Writer with a deliberately long response (completed +9175ms): probes hit from
+1001ms, long before completion. Anthropic's docs confirm and refine this:
the prefix is cached "once the response begins", and "for concurrent
requests, a cache entry only becomes available after the first response
begins". Visibility delay is therefore the writer's time-to-first-token plus
propagation, one mechanism that explains both the prefix-size scaling
(prefill time) and the model dependence (fable's multi-second TTFT). The docs
also state responses are never cached ("caches its request content (not the
response)"), so H1 is documented behavior, independently verified here.

### 5. Visibility is stochastic, per-request, heavy-tailed (~0.4s–1s+)

4-fork stagger runs (1 writer at t=0, 3 delayed), forks that paid the write:

| stagger | runs (paid/4) | delayed-fork free-ride rate |
|---:|---|---:|
| 0–300ms | 3/3, 4/4, 4/4, 4/4 | 0% (0/12) |
| 400ms | 4, 2, 3, 4, 1 | 40% (6/15) |
| 450ms | 4, 1, 2, 4, 2 | 47% (7/15) |
| 500ms | 1, 3, 1, 1, 4, 4 | 56% (10/18) |
| 550ms | 1, 4, 4 | 33% (3/9) |
| 600ms | 4, 1, 4 | 33% (3/9) |
| 650ms | 1, 1, 3 | 78% (7/9) |
| 700ms | 4, 1, 1 | 67% (6/9) |
| 750ms | 1, 1, 1, 1 | 100% (12/12) |
| 800ms | 1, 1, 1 | 100% (9/9) |
| 900ms | 1, 1, 1 | 100% (9/9) |
| 1000ms | 1, 1, 1, 1, 1, 4, 1, 1, 1 | 89% (24/27) |
| 1100ms | 1 ×5 | 100% (15/15) |
| 1250ms | 1 ×5 | 100% (15/15) |
| 1500ms | 1 ×5 | 100% (15/15) |
| 2000ms | 1 ×5 | 100% (15/15) |

Two variance modes:

- Per-fork (runs with 2/4, 3/4): simultaneous forks get different outcomes;
  propagation across cache nodes/shards is per-request.
- Per-run (all-or-nothing 1/4 vs 4/4 at the same stagger, dominant in the
  550–700ms batch, plus one 4/4 at 1000ms): the stagger is client-measured,
  but the write commits at writer *ingestion*, which is fire + network +
  server queue and varies by hundreds of ms run-to-run. A client-side delay
  cannot control this term.

There is no exact stability point: p(free ride) ramps noisily through
0.4–0.7s and is high beyond ~750ms, but not 1. The lone 4/4 failure at
1000ms shows the tail crosses 1s at least occasionally. Aggregates: ≥750ms =
1 miss in 39 runs (~3%); ≥1000ms = 1 miss in 29 runs; the 1000ms point itself
= 1 miss in 9 runs. The clean 100% cells (n=3–5 each) are consistent with a
low-but-nonzero miss rate, not proof of a plateau. Treat any threshold as
probabilistic.

This refines "parallel writers all pay" (first experiment's P4a): requests
ingested within the propagation window cannot see each other's writes, and
sharing resumes beyond it. The practical consequence is the same.

Prompt length scales the visibility delay. All runs above used a ~6.5K prefix
and ~150-token M. Scaling either pushes the window out (runs affected by
misses at the given stagger):

| prefix | M | stagger | runs affected | free-ride rate |
|---:|---:|---:|---|---:|
| 6.5K | ~150 | 1s | 1/9 | 89% (24/27) |
| 6.5K | ~1000 | 1s | 1/6 | 83% (15/18) |
| ~25K | ~150 | 1s | 2/6 (full misses) | 67% (12/18) |
| ~50K | ~150 | 1s | 3/6 (2 partial, 1 full) | 61% (11/18) |
| ~50K | ~150 | 2s | 1/6 | 83% (15/18) |

Prefix scaling is clear: at a 1s stagger, miss-affected runs grow
1/9 → 2/6 → 3/6 as the prefix grows 6.5K → 25K → 50K, consistent with
ingestion-time commit (prefill scales with prefix tokens even when
cache-read). 2s recovers reliability at 50K but still missed 1 of 6 runs.
The long-M effect is suggestive at best: 1/6 runs vs 1/9 baseline is within
run-level jitter, not established. At realistic driver contexts (30–100K+),
no small fixed stagger is reliable. Caveats: n=6 per cell; single model
(claude-haiku-4-5); all runs same afternoon from one network, so time-of-day
load and routing are uncontrolled confounders.

### 6. Visibility delay is model-dependent (fable ≈ 6× haiku)

Same harness on `claude-fable-5` (opus-successor; same padding tokenizes to
~8.8K, M capped at max_tokens=300, harmless since M is replayed bytes):

| stagger | runs (paid/4) |
|---:|---|
| 1s, 2s, 3s | 4/4 ×3 each (all pay) |
| 6s, 8s | 1/4 ×2 each (clean) |

Timing probe on fable: misses through +4s, hits from +6s; writer completed at
+15.8s. Commit-at-ingestion holds on fable too, but the visibility floor is
~4–6s at a small prefix (vs 0.5–1s on haiku), consistent with slower
opus-class prefill. Prefix-size scaling untested on fable (each 50K run ≈
$0.90); expect it to be worse.

Thinking at xhigh (fable, adaptive + `output_config.effort`) changes nothing
about the mechanism. Streaming the writer and timestamping its
`message_start` ("response begins", the documented commit point) decomposes
all visibility delay into TTFT + transport:

- Writer TTFT at ~8.8K prefix: 3.0–5.2s with thinking, about the 4–6s
  fire-relative band measured without thinking. Thinking happens after the
  commit point, so it does not delay visibility.
- Commit-anchored staggers: clean free rides at commit+1000/500/250 and even
  commit+0 (×2 fable, ×1 haiku).
- Negative-offset bracketing (haiku): forks dispatched up to ~430ms *before*
  the client-observed commit still hit (transit covered the gap); misses only
  from ~−470ms. Server-side propagation is indistinguishable from zero within
  the ~±300ms transit/queue measurement floor. The earlier "stochastic
  0.4–1s band" was the TTFT distribution (commits measured at 0.69–1.25s),
  not cache propagation.
- M with thinking blocks replays cleanly with real signatures: forks read
  prefix+M exactly, and `cache-thinking-walkback.mjs` confirmed that the
  driver-next-turn shape (no marker on M) walk-back hits across
  thinking-bearing M (read = prefix + M to the token, wrote only its
  followup; reproduced ×2: 8141 = 7175+966 and 8132 = 7175+957).
- Gotcha: `cache_control` on a thinking block is an API error. Mark the last
  *text* (or tool_use) block of M; if max_tokens truncated M mid-thinking
  there may be none.

Pricing (per MTok, pi registry): input $10, output $50, cacheRead $1,
cacheWrite $12.50. Base is 3.33× Sonnet; the multipliers are identical
(1.25× / 0.1×). For N=4 heads and M≈500: worst case all-pay ≈
$0.025/turn, perfect sharing ≈ $0.008/turn; capturing the contended delta
(~$0.017/turn) would require ≥6s staggers. One fork's own cache-read at a
100K context costs $0.10 on fable, so M-contention stays a single-digit %
of observation spend.

Real-session calibration (this repo's pi session: fable, xhigh thinking,
96 requests, context grown to ~187K tokens, $19.04 driver cost):

- M per assistant message (output incl. thinking; pi-ai retains thinking
  blocks and signatures in history, verified in convertMessages): median 604,
  mean 1278, max 9952 tokens.
- Incremental cacheWrite per driver request: median 1166, mean 2319,
  max 26164 tokens. input ≈ 2 tokens/request: pi's marker placement is
  already optimal on the request side; nothing about it is "n-1 by choice".
- At this context, one observation's own prefix read costs ~$0.19 on fable.
  M-stakes (mean M, marker-on-M miss) ≈ $0.016; the marker-vs-no-marker
  delta ≈ $0.003; driver pre-warm ≈ $0.015 when it lands. M-handling is a
  single-digit % of observation cost at real context sizes.
- Implementation note: fork-from-n must append M exactly as pi-ai serializes
  it in history, including thinking blocks and signatures, or the pre-warm
  entry won't match the driver's next prefix. Place the marker on M's last
  text/tool_use block, never on a thinking block (API error). The observation
  must also replay the driver's exact thinking config: per Anthropic's
  invalidation table, thinking-parameter changes invalidate the entire
  messages cache (hydra's byte-replay does this by construction). On
  Opus 4.5+/Sonnet 4.6+-class models (incl. fable), appending the observation's
  user message after thinking-bearing M keeps the cache valid (thinking
  blocks preserved); on Haiku-class models prior thinking blocks are
  stripped, but driver and observation payloads strip symmetrically, so prefix parity
  survives.
- Anthropic's sanctioned pre-warm (`max_tokens: 0`) cannot serve as a
  pointer-advancer for thinking-enabled drivers: it is rejected when thinking
  is enabled, and a no-thinking pre-warm would not share the messages cache
  (thinking-parameter mismatch invalidates it). Since any dedicated advancer
  also pays 0.1× on the full prefix, the observation fork is the only viable and
  only economical pointer-advancer.

### 7. Races are cost-neutral

A fork (or driver) that misses the entry pays exactly what it would have paid
with no other writer. A lost race wastes the pre-warm; it never adds cost.

## Design consequences for hydra

1. Fork from n instead of n-1. The heuristic saves ~1.0–1.25× of a few hundred
   tokens (sub-millicent) and is the direct cause of stale observations.
2. Put a cache_control marker on M in the observation payload: the observation's
   write pre-warms the driver's next turn (the driver reads M at 0.1× instead
   of writing it at 1.25×). Net system cost ≈ +0.1× of M. Mind the
   4-breakpoint request limit when adding it.
3. Write visibility has no usable fixed threshold at scale. At a 6.5K prefix,
   staggers ≥750ms landed in ~97% of runs overall (38/39; at the 1000ms point
   itself: 8/9 runs, 89% of forks). The delay scales with prefix size: at
   ~50K, 1s missed in 3 of 6 runs and 2s still missed 1 of 6. The driver
   pre-warm still works for human-paced turns (many seconds later), but
   auto-triggered immediate turns on large contexts should expect to race,
   cost-neutrally (see 7).
4. Recommended delay: none, single or multiple heads. Fire all forks in
   parallel at run end, each with a marker on M. Rationale: (a) the contended
   amount is only M; worst case for 4 heads ≈ $0.009/turn at Sonnet,
   while sharing perfectly saves ~$0.005, about 3% of one observation's own
   cache-read cost at a 100K context. (b) No fixed stagger is reliable at
   realistic context sizes (see prefix scaling). (c) Feedback latency is the
   product metric; deliberate delay recreates the staleness problem hydra
   exists to fix. Marker-on-M beats no-marker whenever hit probability
   exceeds ~22% (expected 1.25(1−p)+0.1p vs 1.0), and the first-committed
   write pre-warms the driver's next turn regardless. Zero delay is also safe
   for reading the driver's prefix: commit-at-ingestion means the driver's
   cache writes landed seconds before its run ends (the response streamed in
   between), which is why the 500ms propagation delay once carried by the pi
   extension was unnecessary. Revisit only if footer telemetry shows M-write
   spend actually mattering (e.g. very verbose turns × many heads).
   Fable strengthens the no-delay call: visibility is writer TTFT (~3–5s on
   fable at small prefixes, more at large) plus ~zero propagation, so a
   reliable fixed stagger costs more latency than ever, while the contended
   amount stays a single-digit % of observation spend. Driver pre-warm on fable
   lands when the next turn starts after the observation's TTFT, still typical
   for human-paced turns.

   Multi-head accounting has two framings, and both are true. Per-fork, races are
   cost-neutral: no fork (or driver) ever pays above its solo no-sharing
   baseline. In aggregate, N simultaneous markered forks place N marker bets
   of which at most one is read by the driver: overhead +0.25N×M vs unmarked
   forks if nobody reads, and the foregone coordination discount is
   (N−1)×1.15×M per turn (≈ $0.044/turn for 4 heads at mean M=1278 on
   fable; ~6% of the observations' own prefix-read cost). The commit-anchored
   runs validated a precise capture mechanism with no stagger-guessing: fire
   head 1 first, fire heads 2..N at its `message_start` event. Commit+0
   free-rides reliably (×3 runs, both models), and follower delay equals the
   writer's measured TTFT, exactly. Default to latency-first (all parallel at
   run end); offer message_start-coordination as a cost-first config.

   Mid-run turns: piggyback on the driver instead of pre-warming it. Inside a tool
   loop the driver fires request N+1 (containing M plus tool results) within
   ms–seconds, usually inside the observation's TTFT, so a fork-from-n marker
   bet is almost always wasted there. Invert it: observe at the driver's own
   commit point. pi sees `before_provider_request` (N+1 dispatched) and the
   response's `message_start` (the commit, no estimation needed); fire ALL
   observations then, forked from N+1's captured payload plus observation prompt.
   Strictly dominant mid-run: a pure 0.1× read for M and the tool results
   (the driver paid the write anyway, so the "double pay" vanishes), a
   fresher snapshot, zero coordination between heads, and the verdict
   typically lands while response N+1 is still generating. Hybrid policy:
   mid-run, piggyback at the driver's commit; run-ending turn, fork-from-n
   with the marker on M, fired immediately. Implemented in `index.ts` and
   live-verified on fable/xhigh: 7/7 piggybacks were pure cache reads with no
   post-commit delay (the extension's own dispatch latency clears the
   visibility jitter), and every run-end fork wrote exactly M's tokens. A
   500ms grace guard was added, measured unnecessary, and deleted.
   Run-ending turns differ for one structural reason: there is no next driver
   request to ride on. Nobody will carry the final M into the cache until the
   user's next prompt, so the observation must carry M itself. That gap is
   human-paced (≫ observation TTFT), so the marker bet reliably pays there.

   Lookup mechanics per mode: the piggyback fork replays the driver's payload
   byte-identically (markers included) and appends its prompt unmarked. Its
   deepest breakpoint is the driver's own tail marker, an exact hit on the
   entry the driver just wrote: no walk-back, no new markers, no 4-breakpoint
   pressure. The run-end pre-warm is the one path that needs walk-back: the
   driver's next request must find the observation's M-marker entry within the
   20-block lookback window; next user prompts add 1–2 blocks, comfortably
   inside. Verified live end-to-end (June 2026, cross-process `pi -p`
   sessions): the driver's next first request read prefix+M to the token
   (5292 = 4867 + 425) and wrote only its new user prompt (21 tok).
   Re-verification procedure: [`../docs/architecture.md`](../docs/architecture.md#observation-timing).
