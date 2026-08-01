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

PENDING — the judging pass was still running when this document was
written. Ground truth is confirmed (4/4 defects, all manually confirmed;
liveness windows intact).

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
