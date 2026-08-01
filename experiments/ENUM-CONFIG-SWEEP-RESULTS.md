# ENUM config sweep — results (2026-08-01)

Pre-registered in `ENUM-CONFIG-SWEEP-SPEC.md` (af95788, before data).
Instrument: `adaptive-skip-probe.mjs`, recorded-payload replay through the
production `mergeObservationPayload` path. Arms MAIN, F2, ENUM (rendered
strings from `enum-plus-variants.mjs`, byte-identical to the ENUM+ probe
and the trajectory run). 60 calls, zero errors, **$2.22 spent**.

opus-high is the reference column and was not re-run.

## Cells RUN, and one NOT RUNNABLE

| cell | status |
|---|---|
| opus-xhigh, mid prefix (L=20,165) | run, 10 samples x 3 arms |
| opus-xhigh, long prefix (L=37,892) | run, 10 samples x 3 arms |
| sol-high, sol-xhigh | **NOT RUNNABLE — see "The sol gap"** |

## G1 — does ENUM's zero thinking transfer? CONFIRMED at opus-xhigh

Threshold: confirmed iff skip rate >= 8/10; refuted iff <= 4/10.

**opus-xhigh, mid prefix L=20,165**

| arm | skip | mean | median | raw per-sample reasoning |
|---|---:|---:|---:|---|
| MAIN | 4/10 | 688 | 899.5 | `1096 0 776 0 1218 0 0 1036 1023 1731` |
| F2 | 1/10 | 788 | 865 | `0 1195 530 863 1212 714 895 867 653 954` |
| **ENUM** | **10/10** | **0** | **0** | `0 0 0 0 0 0 0 0 0 0` |

**opus-xhigh, long prefix L=37,892**

| arm | skip | mean | median | raw per-sample reasoning |
|---|---:|---:|---:|---|
| MAIN | 10/10 | 0 | 0 | `0 0 0 0 0 0 0 0 0 0` |
| F2 | 0/10 | 804 | 760 | `565 531 732 752 768 768 959 1053 676 1236` |
| **ENUM** | **10/10** | **0** | **0** | `0 0 0 0 0 0 0 0 0 0` |

**G1 CONFIRMED at opus-xhigh, at both prefix lengths, 20/20 skips.**

The stronger result is the comparison, not the number. ENUM is the ONLY
arm that skips at BOTH prefixes. MAIN is prefix-dependent — 4/10 at mid,
10/10 at long — reproducing the stochastic, situation-driven pattern the
skip study established. F2 essentially never skips (1/10, 0/10).

So at opus-xhigh, mid prefix, ENUM does something MAIN does not: it
suppresses deliberation at a moment where MAIN deliberates on 6 of 10
samples. Enumeration is not merely inheriting MAIN's cheapness — at this
config it is cheaper than MAIN on the axis that drives cost.

## G2 — does the delivery volume transfer? CONFIRMED

Emitted findings per message (ENUM: length of its `findings` array;
MAIN/F2: 1 when routed, 0 when silent — they cannot emit more by
construction).

| cell | MAIN | F2 | ENUM |
|---|---:|---:|---:|
| opus-xhigh mid | 0.80 | 0.90 | **3.50** |
| opus-xhigh long | 1.00 | 1.00 | **5.00** |

Per-sample ENUM counts: mid `3 3 4 4 4 5 2 4 3 3`, long `5 4 5 4 6 5 5 5 5 6`.

The contract is being followed at this config, so G1 is interpretable.
The one-finding cap on both baselines is visible again, and ENUM's volume
is HIGHER at the long prefix (5.00) than at the mid one (3.50) — more
visible material, more findings, still zero thinking.

## Format validity

Shape-validity (did the arm emit its contracted shape): **10/10 for every
arm in every cell**, including all 20 ENUM samples emitting parseable
`{"findings":[...]}`.

One defect worth recording: at the mid prefix **F2's routed delivery
failed to parse on 1 of 10 samples** (9/10 via `deliveryOf`). ENUM and
MAIN were 10/10 in both cells. So the arm with a parse failure at this
config is the incumbent challenger, not the new one.

## G3 — cost ordering per observation

| cell | MAIN | F2 | ENUM |
|---|---:|---:|---:|
| opus-xhigh mid | $0.03164 | $0.03412 | $0.03373 |
| opus-xhigh long | **$0.02333** | $0.06528 | $0.03387 |

At the mid prefix the three arms are within 8% of each other. At the long
prefix the ordering separates sharply: **ENUM costs 48% less than F2**
($0.0339 vs $0.0653) while MAIN is cheapest at $0.0233.

ENUM's premium over MAIN at the long prefix is legibly volume, not
deliberation: output tokens 539 vs 123, with both arms at zero thinking.
That is the same decomposition the trajectory run found (410 vs 111).

Replay-cost caveat, inherited from the instrument: a recorded payload's
cache entry is long expired, so absolute per-observation cost here is not
comparable to live-fork cost. The ORDERING and the arm-to-arm ratios are
the readable part; reasoning tokens are unaffected either way.

## G4 — provider split: NOT MEASURED. The sol cells cannot be run.

**This is a structural limit of the instrument, not a missing config
entry, and it was confirmed before any sol spend.**

`adaptive-skip-probe.mjs` replays RECORDED DRIVER PAYLOADS. The recorded
payloads in `~/scratch/2026-08-01-hydra-trajectory-pilot/payloads/` are
Anthropic Messages API requests — their top-level keys are `model`,
`messages`, `max_tokens`, `stream`, `system`, `tools`, `thinking`,
`output_config`. And `mergeObservationPayload` is typed and implemented
against that shape (`utils.ts:810`, `captured: AnthropicPayload`,
operating on `.messages` with `cache_control` markers).

An Anthropic driver payload cannot be replayed against an OpenAI model.
The payload IS the driver's Anthropic request; there is no OpenAI content
to merge a tail into. Neither `adaptive-skip-probe.mjs` nor
`trajectory-cost-ab.mjs` contains the string "openai" at all, and
`trajectory-cost-ab.mjs`'s `CONFIGS` holds only opus-high and opus-xhigh.

**What measuring ENUM on OpenAI would actually require**, in order:
1. An OpenAI packaging path for observation payloads in the trajectory
   recorder (the frozen-case producer has one — `payloadTransform` for
   `openai-codex` — but the trajectory harness does not).
2. `CONFIGS` in `trajectory-cost-ab.mjs` extended with sol entries.
3. **A real OpenAI driver trajectory run to record payloads from.** This
   is the expensive part and the reason it is not a flag: there are no
   recorded OpenAI prefixes in this program.
Only then does the replay probe have OpenAI payloads to work with.

A cheaper partial substitute exists and was deliberately NOT used:
`delivery-context-golden-ab.mjs` supports `sol-high`/`sol-xhigh` on
frozen cases. It would answer findings/message and format-validity on
OpenAI, but on ~800-token frozen prefixes rather than 20-38k recorded
ones — a DIFFERENT measurement basis. Given that every cost effect in
this program has moved with prefix length, quietly substituting that
basis would have produced numbers that look comparable and are not. The
spec says "recorded-payload replay only"; improvising was out of scope.

**So the provider-split question stays open.** Framing already split by
provider (F2 best on Anthropic, F1 best on both sol configs), so
enumeration splitting the same way remains a live possibility that this
sweep does not address.

## What ENUM is now established to do, and where

ESTABLISHED (claude-opus-5, scheduler task):
- Zero thinking at **high** (probe 10/10, trajectory 13/13 valid points)
  and at **xhigh** (20/20 across two prefix lengths). Robust to effort
  and to prefix length, where MAIN is not.
- 3.5-5.0 findings per message against both baselines' ~1.00, at every
  config and prefix measured.
- Contract shape emitted validly 100% of the time at both efforts.
- Cheaper than F2 per observation wherever the arms separate (-48% at the
  long prefix), and cheaper at session scale (-24%, trajectory run).

NOT ESTABLISHED:
- **Anything on OpenAI.** Zero sol data; the instrument cannot produce it
  without an OpenAI driver recording.
- **Anything on another task.** Every ENUM measurement is the scheduler
  trajectory.
- Whether the extra findings are BETTER findings — coverage judging was
  out of scope here; the trajectory run's coverage half answers that.
- False-interrupt rate: the trajectory that would measure it has a
  2-point quiet stretch against the 3 required.
