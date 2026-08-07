# ENUM+ — enumeration is free and high-recall; the support clause is not the precision lever (2026-08-01)

Pre-registered in `ENUM-PLUS-SPEC.md` (2c9a05c, before data). One point
(`scheduler/opus-high/a1/r1/6`, L=20,165), opus-high, 4 arms x 10
samples = 40 calls, **$1.5217**, zero errors. Scored with the RESOLVED
metric (`SEVERITY-V4-BLOCKING-TIER.md`): the two reliable binary axes,
`blocking` and `anyHarm`. The 4-level scale and `inDeliverable` are not
used. Rows: `~/scratch/2026-08-01-hydra-enum-plus/`, frozen in
`experiments/artifacts/2026-08-01-enum-plus/`.

Arms. ENUM = MAIN-ENUM (enumeration, NO support clause). ENUM+D = ENUM
plus F2's clause verbatim — "Every claim must be supported by the visible
trajectory." — inserted in F2's own discipline position, **+57 chars, one
sentence, nothing else moved** (asserted byte-exact in
`enum-plus-variants.mjs`). MAIN-ENUM is the base precisely BECAUSE MAIN
lacks the clause; F2-ENUM already carries it and cannot serve as the
clause-absent control.

## Headline: ENUM dominates on every axis measured

| arm | blocking | any-harm | precision | claims/msg | emitted findings/msg | mean thinking | skip | $/obs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| MAIN | **2/2** | 3/8 | **95.0%** | 3.67 | 1.00 | 289 | 7/10 | $0.0214 |
| F2 | 1/2 | 1/8 | 90.0% | 3.00 | 1.00 | 785 | 0/10 | $0.0474 |
| **ENUM** | **2/2** | **7/8** | 92.0% | **7.30** | 3.30 | **0** | **10/10** | **$0.0220** |
| ENUM+D | **2/2** | 5/8 | 91.7% | 9.00 | 4.60 | 1466 | 1/10 | $0.0613 |

ENUM: highest recall on both axes, precision within 3pp of the best,
**zero thinking on all ten samples**, and the cheapest delivered
observation in the set. MAIN is cheaper per call only because it stayed
silent on 4 of 10 (noop); every other arm delivered 10/10.

Raw thinking, point-ordered:
- ENUM   `0 0 0 0 0 0 0 0 0 0`
- ENUM+D `2395 2367 2478 1298 916 1056 0 1434 1581 1139`

## Pre-registered questions

**P1 RECALL — CONFIRMED.** ENUM >= MAIN on claims/message (7.30 vs 3.67)
AND >= F2 on blocking-tier (2/2 vs 1/2). ENUM also carries any-harm
recall 7/8 against MAIN's 3/8 and F2's 1/8.

**P2 PRECISION — REFUTED as written.** The clause had to cut ENUM's
not-real count by >= half while holding claims/message within 20%. It cut
it by **zero** (2 -> 2), precision moved 92.0% -> 91.7%, and
claims/message rose 23% (7.30 -> 9.00). The support clause is not a
precision lever here.

*But the lever was tested against a problem that was not present.* MAIN
raised 5 both-judges-not-real claims in the C2 pool; in THIS cell it
raised 1, and the whole pool holds 3 not-real issues out of 11. There was
almost no noise to remove. P2's refutation is evidence that the clause
does not clean enumeration in a low-noise cell — NOT evidence that
precision is unfixable. Stated per the spec's refutation clause rather
than iterated around.

**P3 COST — CONFIRMED for ENUM, and the clause is catastrophic.**
Enumeration is free: ENUM thinks ZERO on 10/10 samples where F2 thinks
785. And adding ONE 57-character sentence took thinking from 0 to 1466
mean and cost per observation from $0.0220 to $0.0613 — **2.8x, for a
single sentence.** This is the largest single-sentence cost effect
measured anywhere in the program.

**P4 SHAPE — CONFIRMED.** Emitted findings per message: ENUM 3.30,
ENUM+D 4.60, against both baselines' 1.00. The enumerate arms genuinely
enumerate; MAIN and F2 are structurally capped at one finding.

## What the "noise" actually is (read, not counted)

Three issues were unanimously not-real. Reading them matters, because
"precision" here is not what it sounds like:

1. *"scheduler.js never increments job.attempts, never enforces
   MAX_ATTEMPTS, and never writes store.dead"* — raised by **all four
   arms**. Adjacent to the planted `requeue-resets-attempts` defect; the
   driver repaired it later in the session, so the judges reading the END
   state call it not-real. A STALE claim, not a false one.
2. ENUM+D: *"The scheduling analysis did not inspect src/worker.js…"*
3. ENUM: *"The pluralize correctness review did not inspect its remaining
   potential caller…"*

(2) and (3) are PROCESS complaints — "you did not check X" — not
hallucinated defects. So the enumerate arms' extra not-real claims are
meta-commentary about the driver's coverage, not invented bugs. A
precision metric that counts them as noise is being harsh in a specific,
namable way.

## Judge reliability in this cell

V1 gate `harmIfExecuted` exact **72.7%** (8/11), adjacent 90.9% —
**VIABLE**, and better than v2's 61.9% on the C2 pool. `inDeliverable`
72.7% here vs 38.1% there; `reachable` 27.3% (worse). Consistent with
SEVERITY-V4: the binary axes carry the metric, the graded ones wobble.
The three disagreements are all on `renewLease` variants, including the
seeded `sched-lease-caller-clock` (sol blocking, opus minor) — the same
defect that drew a disagreement in the C2 pool and again carries no
weight.

## Honest limits

- **One point, 10 samples — not a trajectory.** Recall here means "did
  the arm surface this at least once in 10 tries at one moment". Every
  arm got the same ten tries, so the comparison is fair, but it is not
  the trajectory-recall measurement.
- **F2's 1/8 any-harm recall is partly structural**: capped at one
  finding, sampled ten times at ONE point, it says the same thing every
  time. That is the recall ceiling the hypothesis predicted, shown
  starkly — but a trajectory gives F2 different moments and would raise
  it.
- 5 weighted issues, 2 blocking. One flip moves a blocking-tier score by
  50pp.
- MAIN's noop rate (4/10) means its per-call cost is not comparable to
  arms that always deliver.

## What follows

Enumeration gives recall AND cost at once — the two things every earlier
lever failed to move together. The support clause does neither here and
costs 2.8x. The natural next arm is ENUM at trajectory scale (different
moments, not repeated sampling at one), scored on blocking-tier recall,
against MAIN and F2. Precision, if it needs fixing at all, needs a lever
that is not this clause — and a cell that actually contains noise.
