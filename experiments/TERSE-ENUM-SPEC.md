# Terse enumeration — pre-registration (2026-08-01, before data)

## The lever

ENUM's entire premium over MAIN is OUTPUT VOLUME, not deliberation:
410 output tokens vs 111, both at zero thinking (live trajectory,
opus-high). At 4.09 findings per message that is ~100 output tokens per
finding — prose. A terse bullet is 15-25.

Output is the expensive class ($25/M vs cache-read $0.50/M), so a 75%
output cut moves the trajectory ratio materially: ENUM sits at 32.5%
against MAIN's 23.0%, and nearly all of that 9.5pp gap is output.

Andreas: "the driver doesn't need elaborate sentences anyway" — bullets,
plain language, no prose.

## Arms (instruction text only)

- MAIN, ENUM: measured baselines.
- **ENUM-T**: ENUM with a terse output discipline — each finding is one
  bullet, plain language, hard per-finding character cap, no prose
  connectives, no restating the code. Enumeration semantics untouched:
  same "list every finding, no selection" instruction, only the RENDERING
  changes. ENUM-T minus ENUM isolates VERBOSITY.

## Pre-registered questions

- **T1 COST.** Output tokens per observation, ENUM-T vs ENUM. Confirmed
  if ENUM-T cuts output >= 50%. The headline test: does ENUM-T's
  trajectory-equivalent cost reach MAIN's?
- **T2 VOLUME HELD.** findings/message must stay within 20% of ENUM's
  4.09. A cost win from emitting FEWER findings is not a terseness win —
  it is ENUM with the enumeration broken, and must be reported as such.
- **T3 SUPPORT SURVIVES (the decisive risk).** Judged `anyHarm` and
  support on the reliable binary axes. A finding compressed past
  verifiability is worse than a verbose one: refuted if ENUM-T's
  both-judges-not-real rate rises by more than 1 per 10 findings, or if
  blocking-tier recall falls below ENUM's.
- **T4 ACTIONABILITY (descriptive).** Read the bullets: could a driver
  act on this without asking a follow-up question? Quote examples of
  both. No gate — but a terse finding the driver cannot use is a product
  failure the metrics will not catch.

## Refutation

If ENUM-T cuts output but loses support or volume, verbosity is load-
bearing and ENUM's cost is the price of usable findings. Report it; do
not iterate wording to rescue the number.

## Sequencing and cost

Recorded-payload replay, ~$0.60. RUN AFTER the ENUM config sweep lands —
if ENUM's zero-thinking property turns out to be opus-high-specific, the
terse variant must be tested at whatever configs survive, not at
opus-high alone.
