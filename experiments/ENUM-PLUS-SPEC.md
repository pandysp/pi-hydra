# ENUM+ — enumerate with discipline (2026-08-01, pre-registration)

## Why this arm, now

Three independent results point the same way:

1. **Claims per delivered message tracks recall.** MAIN 3.30, F0 2.63,
   F2 2.33 (severity-probe-v2 pool). MAIN is also the only arm that
   caught BOTH unanimously-blocking issues (2/2 vs 1/2).
2. **The envelope has a recall ceiling written into its contract**:
   "write ONE concise lens finding". It structurally cannot report a
   second problem it can see.
3. **Removing steer produced enumeration spontaneously and cheaply**:
   MAIN-NS shifted to "here are the gaps", planted-defect coverage rose
   1.4 -> 2.3-2.5 per sample, thinking fell to ~0 (n=30, p=2.7e-05).

And the precision advantage looks separable: the envelope carries "every
claim must be supported by the visible trajectory"; MAIN carries no such
clause and produced 5 both-judges-not-real claims against the envelope
arms' 1 each.

Hypothesis: **recall and precision have DIFFERENT levers** —
findings-per-observation and the support clause — so a contract that
enumerates AND demands support should get both, rather than trading.

## Arms (instruction text only)

- MAIN, F2: measured baselines.
- **ENUM**: enumerate every finding seen, each with its own delivery
  word; no "one finding" cap; no most-important selection; per-finding
  length discipline retained so verbosity is not the confound.
  (Built already: experiments/enumerate-variants.mjs.)
- **ENUM+D**: ENUM plus the envelope's support clause verbatim — "Every
  claim must be supported by the visible trajectory." Nothing else.
  ENUM+D minus ENUM isolates the PRECISION lever.

## Pre-registered questions

- **P1 RECALL.** blocking-tier recall and claims/message, ENUM and ENUM+D
  vs MAIN and F2. Confirmed if ENUM >= MAIN on claims/message AND >= F2
  on blocking-tier.
- **P2 PRECISION.** both-judges-not-real count per arm. The decisive
  test: **ENUM+D must cut ENUM's not-real count by >= half** while
  holding claims/message within 20%. If the support clause suppresses
  enumeration instead of cleaning it, the levers are NOT separable and
  the tradeoff is real — say so plainly.
- **P3 COST.** mean thinking per sample. Prediction from no-steer:
  enumeration is cheap because it removes the urgency selection. If ENUM
  thinks as much as F2, that prediction is wrong and the enumeration/cost
  story collapses to the label alone.
- **P4 SHAPE.** distinct findings per message — did the arms actually
  enumerate?

## Refutation

If ENUM+D cannot hold recall while cutting not-real claims, the
recall/precision tradeoff is intrinsic to these contracts and the
decision returns to Andreas as a product choice between two operating
points. Do not iterate wording to escape that; report it.

## Cost

Recorded-payload replay, 4 arms x 10 samples x mid prefix = 40 calls
~$0.80, plus judging the claims for reality (subscription-billed).
Zero new trajectories.
