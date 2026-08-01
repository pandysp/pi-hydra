# Adaptive-thinking skip — study pre-registration (2026-08-01, before data)

## The phenomenon

On 19 recorded real driver payloads (opus-high), main's shipped contract
produced ZERO thinking tokens on 13 of 15 observations; the envelope arms
skipped on 2 of 15. On the two points where MAIN did think, it thought
within 2-4% of what the envelope arm thought at the same point (680 vs
704; 210 vs 214). Situation sets DEPTH; contract sets WHETHER.

Mechanism established from source, not inferred: pi-ai sends
`thinking: {type:"adaptive", display:"summarized"}` + `output_config:
{effort}` for claude-opus-5 (`anthropic-messages.js:753-768`,
`forceAdaptiveThinking`). No budget is imposed. The MODEL decides per
request whether to think. Not a backend classifier, not a cache.

## Questions, in order

Q1 DETERMINISM. On a FIXED prefix, is the skip deterministic per
contract? Run MAIN and F2 x 10 samples on one recorded payload.
  - Predicted: MAIN skips >= 8/10, F2 skips <= 2/10.
  - If both are ~50/50, the effect is stochastic and every per-arm mean
    in this program needs wider error bars; say so loudly.

Q2 TRIGGER (the decisive one). Bisect MAIN -> F2 by adding ONE feature at
a time to MAIN's contract, holding everything else byte-identical, and
measure the skip rate on 3 fixed prefixes x 2 samples:
  a. + the routing rules only (the 6-rule block)
  b. + the discipline sentence only ("every claim must be supported...")
  c. + the tool-denial sentence only
  d. + the footer grammar only (JSON -> natural text + DELIVERY line)
  e. + the "at most 240 characters" cap change only
  f. MAIN with its character caps REMOVED (does removing a cap turn
     thinking on?)
  - A feature that moves the skip rate by >= 4 of 6 rows is the trigger.
  - Pre-registered guess (recorded to be wrong): (a) the routing rules.

Q3 CACHING. Andreas's hypothesis: is a semantic cache involved? Fire the
IDENTICAL request twice back to back, then once with a nonce in the
prompt. If the skip is a cache artifact, the repeat differs from the
nonce run.
  - Predicted: no difference; skip is a property of the request content,
    not of having seen it before.

Q4 PREFIX DEPENDENCE. Does the skip depend on the driver prefix (the
situation) or only the contract? Run MAIN on all 19 prefixes x 2 samples
and check whether the 2 thinking points reproduce at the same points.
  - If they do, "hard moments" are a property of the trajectory and both
    arms detect them; that is the cleanest statement of the mechanism.

## Rules

- Zero contract changes ship from this study: it is diagnostic. Any
  contract that comes out of it is proposed, then screened under
  ENVELOPE-REPAIR-SPEC's gates like every other arm.
- Report the full DISTRIBUTION of reasoning tokens per cell: mean,
  median, and skip rate (share with reasoning === 0), plus the raw
  per-observation values. Skip rate is an ADDITIONAL metric, NOT the
  primary one (corrected by Andreas 2026-08-01 before data: declaring it
  primary would presume the bimodal framing that is itself under test).
  The mean alone did hide the effect twice, so it never travels alone —
  but which metric carries the story is a finding, not an assumption.
- Budget: ~$2. Anything larger needs a new pre-registration.
