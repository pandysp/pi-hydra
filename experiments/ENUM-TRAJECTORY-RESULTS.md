# ENUM on a live-fork trajectory (2026-08-01)

ENUM dominated on the resolved metric at ONE observation point sampled
10x (`ENUM-PLUS-RESULTS.md`). That is not the trajectory measurement:
"recall" there meant "surfaced at least once in ten tries at one moment".
This run supplies the trajectory measurement — one live driver run,
three arms observing paired at every production observation point,
exactly the C2 design (`ENVELOPE-REPAIR-RESULTS.md` §C2).

Rows: `~/scratch/2026-08-01-hydra-enum-trajectory/` (frozen under
`experiments/artifacts/2026-08-01-enum-trajectory/`). 78 rows, 15
observation points, 16 driver turns, **zero errors**, 6 invalid run-end
rows (pre-existing pattern — C2 had 4 of 12, the pilot 6 of 12; the
summarizer drops those points across ALL arms, so pairing holds).

## Cost — the headline KPI. ENUM's dominance SURVIVES.

| arm | observer $ / driver $ | C2 baseline | deliveries | mean thinking | zero-think rows | output tok |
|---|---:|---:|---:|---:|---:|---:|
| MAIN | **23.0%** | 32.1% | 8 | 0 | 12/12 | 111 |
| F2 | 42.6% | 58.6% | 9 | 579 | 4/14 | 644 |
| **ENUM** | **32.5%** | — | **11** | **0** | **13/13** | 410 |

- ENUM delivers the MOST (11 vs 9 and 8), thinks **zero on every one of
  its 13 valid observations**, and costs **24% less than F2** at session
  scale: +9.5pp over MAIN against F2's +19.6pp.
- ENUM's premium over MAIN is VOLUME, not deliberation: 410 output tokens
  vs 111, with zero thinking in both. F2 spends 644 output tokens of
  which 579 are pure thinking.

**Cross-run caveat, stated before the numbers are used.** Both baselines
came in below their C2 values (MAIN 23.0 vs 32.1, F2 42.6 vs 58.6). This
is a different driver run with different turn economics — driver cost is
the denominator and it moved. The load-bearing comparison is therefore
the PAIRED within-run one, never the cross-run absolute.

## Shape — the one-finding cap, made visible on real work

| arm | delivered messages | emitted findings | per message |
|---|---:|---:|---:|
| ENUM | 11 | **45** | **4.09** |
| F2 | 9 | 9 | 1.00 |
| MAIN | 8 | 8 | 1.00 |

Both baselines sit at exactly 1.00 — MAIN's `message` field and F2's
"write ONE concise lens finding" are the same ceiling reached two
different ways. ENUM emits 5x the raw finding volume at zero thinking.

## Coverage on the resolved metric

Scored with the two RELIABLE binary axes only (blocking / anyHarm,
`SEVERITY-V4-BLOCKING-TIER.md`); the 4-level scale and `inDeliverable`
are not used. Claims extracted per message with multi-membership, read
from text (never keyword-matched, per the 96eff06 retraction). All three
answer shapes are rendered as prose by `enum-trajectory-adapt.mjs` before
judging, so no arm is identifiable by format.

25 candidate issues from 140 claims across 28 delivered messages.
Judge agreement: 68% exact, **100% adjacent** (every disagreement is one
step; 5 of 8 are the serious-vs-minor boundary) — consistent with
SEVERITY-V4's finding that the middle of the scale is where judges split.

| arm | blocking-tier | any-harm | both-judges-not-real | claims | issues |
|---|---:|---:|---:|---:|---:|
| MAIN | **0/1** | 5/12 | 4 | 27 | 10 |
| F2 | **0/1** | 5/12 | 1 | 22 | 7 |
| **ENUM** | **1/1** | **11/12** | 7 | 91 | 22 |

**The single unanimously-blocking issue is the TOCTOU race** — "claimNext
performs its eligibility check and its saveJob write non-atomically" —
and **ENUM alone found it**. On any-harm recall ENUM reaches 11 of 12
against both baselines' 5.

ENUM's 7 not-real claims against MAIN's 4 and F2's 1 is the expected
price of emitting 91 claims against 27 and 22. Precision on the pipeline's
own blends: ENUM 73.1% mechanism / 79.4% practical, F2 75.0/83.3,
MAIN 42.9/55.6 — ENUM is MORE precise than MAIN while finding 3.7x more.
Weighted recall on those blends: ENUM 95.0/96.4%, F2 15.0/17.9%,
MAIN 15.0/17.9%, and ENUM is the only arm with topHit=true.

Ground truth confirmed: 4/4 defects, all manually confirmed, liveness
windows intact.

## Corpus validity, honestly

`Q0a` reports **pass: false** on this trajectory. Liveness is sound —
4/4 defects have non-empty windows and all four confirmations passed —
but the longest quiet span is **2 points** against a required 3 (defects
become visible at point 2, so only points 0-1 are quiet). Consequence:
this trajectory CANNOT measure false-interrupt rate. Coverage and cost
are unaffected.

One payload/file derivation disagreement on
`sched-requeue-resets-attempts` (payload says fixed at 11, disk at 10) —
the known surgical-edit case the deriver documents; settled by the
manual confirmation.

## Instrument changes this run required

- ENUM registered in `trajectory-cost-ab.mjs` ARM_PROMPTS, imported as
  the rendered string from `enumerate-variants.mjs` so a trajectory row
  and an ENUM+ probe row carry byte-identical contract text; a
  module-load assertion checks it was rendered against this harness's
  lens.
- `parseEnumDecision` for the `{"findings":[...]}` shape: the row's
  single `delivery` takes the MOST URGENT action in the batch (a batch
  containing a steer interrupts the driver whatever else it carries),
  while every finding is preserved. Coverage is read from `responseText`,
  never from that collapsed field.
- ENUM is exempt from the registry-equivalence invariant (it is a
  deliberate throwaway diagnostic, not a registry arm) and carries a
  PROVENANCE assertion instead: it must still be MAIN plus exactly the
  two documented edits.
- `enum-trajectory-adapt.mjs` — format normalisation before judging.

## Spend

**$2.31 total** for the trajectory run: driver $0.9977, observers $1.3113
across three arms. Judging is subscription-billed ($0). Under the ~$4
budget.

## Verdict

ENUM's one-point dominance SURVIVES the trajectory, on both axes:
- COST: 32.5% vs F2's 42.6%, most deliveries, zero thinking on 13/13.
- COVERAGE: the only arm to catch the blocking issue (1/1 vs 0/1), and
  11/12 any-harm against both baselines' 5/12.

The tradeoff it pays is noise: 7 both-judges-not-real claims. But its
PRECISION still beats MAIN's (73.1% vs 42.9% mechanism-blend), so this is
not a recall-for-precision trade against the shipped baseline — only
against F2, which is quieter, costlier and blind to the blocking issue.

Limits: n=1 trajectory, 1 blocking issue in the pool (one flip moves the
blocking column entirely), quiet span too short to measure false
interrupts, and cross-run cost absolutes are not comparable.
