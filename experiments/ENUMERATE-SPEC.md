# Enumerate-vs-select probe — pre-registration (2026-08-01, before data)

## The hypothesis the no-steer result opened

no-steer v1 measured MAIN-NS at 132 mean thinking (-77%) with planted-
defect coverage UP (1.4 -> 2.5 per sample), and one ZERO-thinking sample
naming three planted defects. The shape shifted from "one urgent thing to
stop for" to "here are the gaps".

That suggests the expensive act is **SELECTION** — choosing the single
most important finding and justifying interrupting for it — not FINDING.
If so, an observer instructed to ENUMERATE what it sees, leaving triage
to the runtime/driver, should be cheaper AND higher-coverage than one
instructed to pick.

This is the cost mechanism nothing has touched: framing, decidability and
label-removal all left the ENVELOPE's cost untouched (F2-NS = F2). If
selection is the driver, it explains that too: F2's rule surface IS a
selection procedure.

## Arms (instruction text only)

- MAIN, F2: measured baselines on the same prefixes.
- **MAIN-ENUM**: MAIN's contract, but instead of one action + one message,
  it lists every finding it sees (each with its own delivery word), no
  ranking, no "pick the most important". Runtime would triage.
- **F2-ENUM**: F2's semantics with the first-match SELECTION removed —
  the rules become labels applied to each finding found, not a procedure
  for choosing one. Everything else byte-identical.

Both keep the 240-char-per-finding discipline so verbosity is not the
confound; enumeration bounds the LIST, not the item.

## Pre-registered questions

- **E1 COST.** Does enumeration reduce thinking vs its parent, at the mid
  prefix, n=10 each? Confirmed if MAIN-ENUM < MAIN and F2-ENUM < F2 by
  >= 30% mean thinking. The F2 arm is the decisive one: nothing has moved
  it yet.
- **E2 COVERAGE.** Planted defects named per sample, READ from the
  messages, never keyword-matched (96eff06). Confirmed if ENUM >= parent.
  A cost win from not noticing is a loss.
- **E3 NOISE.** Count claims per sample that are not planted defects and
  not evidenced by the visible code (read them). Enumeration's obvious
  failure mode is spraying; if ENUM's unevidenced-claim rate exceeds its
  parent's by more than 1 per sample, the cost win is bought with noise
  and the design is refuted regardless of E1/E2.
- **E4 SHAPE.** Report the number of distinct findings per message. This
  is descriptive: it says whether the arms actually enumerated.

## Refutation

If F2-ENUM does not move F2's thinking, SELECTION is not the envelope's
cost driver either, and the rule-surface cost stays unexplained. Say so;
do not iterate wording to rescue it. The remaining untested candidate is
then the Q2 trigger bisection (which unit of the envelope turns thinking
on), which needs ~40 samples/variant and its own pre-registration.

## Cost

Recorded-payload replay, 4 variants x 10 samples x 1 prefix = 40 calls,
~$0.80. No judges. No new trajectories.
