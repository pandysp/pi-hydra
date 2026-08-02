# OpenAI trajectories — sol-high / sol-xhigh × MAIN / F2 / ENUM (2026-08-02)

Runs A of `ENUM-GENERALISATION-SPEC.md` (pre-registered before data),
answering N1 (provider), N2 (cost shape) and N4 (contract honesty) on real
GPT-5.6-sol driver trajectories. Instrument: `trajectory-openai.mjs` —
production split handoff (user lens + developer envelope), shared codex
session for cache riding, OpenAI-calibrated cache assertions, cost model
charging cacheRead/input/output and never a cache write (13/13 offline
invariants green). Arms carry byte-identical contract text to every
Anthropic run (ENUM rendered from `enum-plus-variants.mjs`).

Two complete cells: scheduler × sol-high (20 points, 4 driver runs) and
scheduler × sol-xhigh (19 points). 199 rows, 117 observations, exactly one
provider error (a transient WebSocket failure, ENUM, one point). Rows:
`~/scratch/2026-08-01-enum-openai/`, frozen under
`experiments/artifacts/2026-08-02-openai-trajectory/`. Harness spend
**$3.20** across both cells including drivers.

Analysis: `analyse-openai-trajectory.mjs` — deliberately separate from the
Anthropic summarizer so OpenAI numbers are never reported under Anthropic
cache accounting.

## N1 — REFUTED: ENUM's zero-thinking does NOT transfer to OpenAI

| cell | arm | skip | mean thinking | findings/msg | format |
|---|---|---:|---:|---:|---:|
| sol-high | MAIN | 0/16 | 253 | 1.00 | 16/16 |
| sol-high | F2 | 1/17 | 227 | 1.00 | 17/17 |
| sol-high | **ENUM** | 1/17 | **402** | 2.12 | 17/17 |
| sol-xhigh | MAIN | 0/14 | 405 | 1.00 | 14/14 |
| sol-xhigh | F2 | 0/14 | 401 | 1.00 | 14/14 |
| sol-xhigh | **ENUM** | 0/14 | **775** | 3.00 | 14/14 |

On Anthropic, ENUM skipped thinking on 33/33 valid observations at both
efforts and was cheaper than MAIN on the thinking axis. On sol the
ordering INVERTS: 2 zero-reasoning rows in 92 valid observations across
ALL arms, and ENUM thinks the most — roughly MAIN + 60% at high and
MAIN + 90% at xhigh — while also emitting the most output (509 vs 301
tokens at high). The early 516-token smoke signal replicates as the
regime, not an outlier.

**The mechanism behind the Anthropic result is absent here.** On opus,
thinking tracked the routed delivery (steer ~1000, queue 0, replicated).
On sol, pooled valid rows:

| routed delivery | sol-high mean thinking | sol-xhigh mean thinking |
|---|---:|---:|
| none | 153 (n=5, 0 zeros) | 341 (n=9, 0 zeros) |
| queue | 486 (n=2) | 654 (n=4) |
| steer | 302 (n=43) | 567 (n=29) |

`none` rows think, and `queue` rows think MORE than steer. The
delivery-type coupling — the load-bearing cost mechanism on Anthropic — is
a Claude adaptive-thinking behavior, not a property of the contracts.
GPT-5.6 reasoning at high/xhigh is effectively always-on, so no contract
earns a skip discount there.

Provider-split verdict, stated plainly: **enumeration is the cheap arm on
Anthropic and the expensive arm on OpenAI.** This is the second measured
provider split of this kind (framing helped Claude and hurt GPT on the
user-actor corpus). Contract choice per provider stays an
instruction-text decision — inside the branch-cost rule — but any unified
recommendation that assumes ENUM's cost profile generalises is now
refuted.

## N2 — cost shape: ratios double, absolutes don't

| cell | arm | observer $/driver $ | $/valid obs |
|---|---|---:|---:|
| sol-high | MAIN | 51.1% | $0.0212 |
| sol-high | F2 | 57.3% | $0.0223 |
| sol-high | ENUM | 69.1% | $0.0270 |
| sol-xhigh | MAIN | 58.7% | $0.0269 |
| sol-xhigh | F2 | 64.0% | $0.0293 |
| sol-xhigh | ENUM | 87.5% | $0.0401 |

Beside the Anthropic opus-high baselines (MAIN 23.0%, F2 42.6%, ENUM
32.5%) these ratios look catastrophic. The basis difference carries most
of it: **the sol driver costs ~$0.033/turn against opus's ~$0.062/turn**,
so the denominator halves while per-observation absolutes stay close
(Anthropic ENUM ≈ $0.025/obs live-fork vs sol ENUM $0.027 at high).
Ratios across providers are NOT comparable head-to-head; the honest
cross-provider statements are (a) per-observation dollars, which are
similar, and (b) the within-provider arm ordering, which flips: on sol
MAIN < F2 < ENUM at both efforts.

Also real: sol intervenes far more than opus on the same task and arms
(steer on 11-16 of ~16 deliveries per arm at high vs opus's 2 steers for
MAIN). More deliveries, more output, cheaper driver — all three push the
ratio up. Cost per delivered observation is the fairer unit here.

## N4 — contract honesty: everything followed

- ENUM findings/message 2.12 (high) and 3.00 (xhigh) — genuinely
  enumerating (baselines pinned at 1.00), though notably below its
  Anthropic volume (4.09 trajectory, 3.5-5.0 sweep). GPT enumerates
  fewer findings per message.
- Format validity 92/92 valid rows across all arms and cells; zero parse
  failures (the one prior parse failure in this program remains F2's, on
  Anthropic).
- One invalid arm call: WebSocket error (ENUM, sol-high r3/18). The
  summariser drops nothing else for that point's siblings; pairing holds
  at every other point.

## Cache noise, separated from arm effects (the 07-17 backend finding)

25 of 117 observation rows failed the OpenAI cache floor and are excluded
from every number above:

- **20 are structural, not noise**: all at run-0 prefixes of 1,701-2,689
  tokens, where 512-token block quantization plus the 1,024-token caching
  minimum make an 80% floor unreachable (reading 1,536 of 2,092 tokens is
  the correct backend behavior and still fails the gate). A floor keyed to
  block-rounded prefix would re-admit them; not done here — the cost
  numbers stay conservative.
- **4 are the known stochastic cache-routing loss** (zero or partial read
  at 12-28k prefixes): ~5% of mid-run observations, consistent with the
  measured 11%-and-volatile backend behavior (openai/codex#33821). These
  are backend noise, not arm effects, and production WILL pay them; the
  per-arm comparison rightly does not.
- 1 WebSocket error.

Mean cache-hit ratio on valid rows: 91-94% every arm, every cell — the
shared-session cache riding works on real trajectories.

## Anomalies noted, triaged

- **Exactly 516 reasoning tokens appears 6× across arms and cells** (and
  the smoke run's early signal was also 516). Reasoning-token reporting on
  the codex backend appears block-granular. Means are unaffected;
  per-row values should be read as quantized. Triage: backend reporting
  artifact, not harness bug, not arm effect.
- Driver turn counts differ (20 vs 19 points) because the sol-high driver
  took one more turn on run r0 — normal trajectory variance, pairing is
  within-cell only.
- No coverage/quality judging in these cells (N3 is the cross-task run's
  question; judged quality on sol trajectories is future work — the
  frozen-case screens already hold judged sol cells).

## What this changes

1. **Goal-1 cost reading (OpenAI live)**: the envelope-family arms are no
   longer the expensive option on OpenAI — ENUM is. F2's premium over MAIN
   is 6-5pp of driver cost (57.3 vs 51.1, 64.0 vs 58.7) — small against
   its Anthropic premium and against ENUM's.
2. **ENUM's case is now Anthropic-scoped** until judged sol coverage says
   its extra findings are worth 18-29pp of driver cost on OpenAI.
3. **The skip study's mechanism is provider-local.** Any cost lever built
   on delivery-type thinking (no-steer promotion, label removal) targets
   Anthropic only and needs no OpenAI counterpart.
