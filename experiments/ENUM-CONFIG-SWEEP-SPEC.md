# ENUM config sweep — pre-registration (2026-08-01, before data)

## Why

Everything ENUM has been measured at is claude-opus-5 at HIGH: one probe
point x 10 samples, and one trajectory (15 points), both on the scheduler
task. The results are strong there — zero thinking on every valid
observation, most deliveries, 24% cheaper than F2 at session scale, 4.09
findings per message against both baselines' 1.00.

None of that is safe to generalise, for two measured reasons:
- **Effort changes cost effects in this program, repeatedly.** F0's
  premium was +15% at opus-high and +48% at opus-xhigh. F2's framing cut
  thinking 23% on long prefixes and RAISED it 57% on short ones at xhigh.
- **Providers split.** Framing helped Claude and hurt GPT on the
  user-actor corpus (F2 best on opus-high at 91.7 fq; F1 best on both sol
  configs, F2 trailing at 58.3). Enumeration could split the same way.

Andreas's guiding configs are opus-5 high AND xhigh, with sol high and
xhigh measured wherever opus is.

## Design

Recorded-payload replay only (experiments/adaptive-skip-probe.mjs) — no
driver runs, no new trajectories. Arms MAIN, F2, ENUM at the mid prefix
(L=20,165) plus, for Anthropic, the long prefix (L=37,892) so a
prefix-length interaction is visible.

Cells: {opus-xhigh, sol-high, sol-xhigh} x {MAIN, F2, ENUM} x 10 samples.
opus-high is already measured and is the reference column.

## Pre-registered questions

- **G1 (the one that matters): does ENUM's ZERO thinking transfer?**
  Confirmed at a config iff ENUM's skip rate >= 8/10 there. Refuted iff
  <= 4/10 — then zero-thinking enumeration is an opus-high property, not
  a contract property, and every claim made from it must be re-scoped to
  that config in the decision table.
- **G2 does the DELIVERY VOLUME transfer?** findings/message for ENUM vs
  the baselines' ~1.00. This is the mechanism; if the arms all emit one
  finding at another config, the contract is not being followed there and
  G1 is uninterpretable.
- **G3 cost ordering.** Per-observation production-priced cost, ENUM vs
  MAIN vs F2 per config. Report; the trajectory ratio needs a driver run
  and is out of scope here.
- **G4 provider split.** State plainly whether ENUM behaves differently
  on OpenAI, given framing already did.

## Rules

Read raw per-sample reasoning values, not just means — the distribution
is bimodal and means hid this effect twice (SEVERITY-V4 lesson). Report
skip rate, mean, median AND raw values per cell. Format-validity per arm
must be reported: an arm whose output does not parse at a config is not
"cheap", it is broken there.

Budget: 3 configs x 3 arms x 10 samples x (1-2 prefixes) = 90-150 calls.
Anthropic cells are plan-billed; sol cells ride the codex subscription.
