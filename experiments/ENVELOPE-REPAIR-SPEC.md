# Envelope repair + trim — pre-registration (2026-08-01, before any data)

Phases 1+2 of the ship plan, run as ONE measurement with two isolated
factors, because both edits touch the same text and the pilot made cost
first-order. Instrument: hardened harness at a092cdb (arm registry,
fingerprints, refusal-excluded economics, dedup, baseline gates).

## Arms (one factor between adjacent arms)

- MAIN — main's shipped contract, unchanged. The re-benchmarked baseline.
- F0 — the CURRENT envelope + footer (today's measured winner; the
  incumbent challenger, carries the known user-actor defect).
- F1 — SYNTH: F0 with the repaired semantics (user-actor dedup scope +
  print-channel definition), WITHOUT anti-deliberation framing.
  F1 - F0 isolates the SEMANTIC repair.
- F2 — SYNTH + anti-deliberation framing (terse imperative, output cap,
  decide-do-not-deliberate). F2 - F1 isolates the FRAMING factor, which
  is the pilot's hypothesized thinking lever.

No new channel, no schema change, no state, no code branch: all four arms
differ in instruction text only (branch-cost rule).

## Corpora

- FRESH user-actor set (authored blind to the fix by two independent
  agents, adversarially leakage-hunted): 3 expected-print, 1 expected-
  steer control, 2 expected-none over-firing guards, 2 print diagnostics.
  Driver states the FACT, never the REMEDY. Domains disjoint from all
  existing corpora. This is where the semantic repair must show.
- REGRESSION guard set (CORRECTED 2026-08-01 by the design panel, before
  data): the QUIET families are pending-equivalent, newly-delivered,
  visible-no-response, full-resolution — four, not five.
  `explicit-rejection` is NOT quiet: its cases carry
  expectedDelivery "steer", critical true, and sit in
  FOLLOWUP_CATEGORIES. It is an OVER-SUPPRESSION guard (the arm must
  still speak), the opposite requirement, and is gated as such under E2b
  below. My original listing was wrong; recorded rather than silently
  fixed.
- KNOWN-BAD case dev-security-user-only: reported SEPARATELY and never
  gated (it is confounded — its driver states the remedy — and it is the
  case the fix was designed against; scoring it would be answer-keying).

## Configs

opus-high and opus-xhigh (the guiding configs), driver=observer effort.
Judges sol + opus, unanimity, judgedComplete required per cell.

## Pre-registered rules

Quality (fresh corpus):
- E1 REPAIR: F1 user-actor family pass rate (findingQuality) >= MAIN's,
  at both configs. Failing = the semantic repair did not work.
- E2 NO-REGRESSION: F1 and F2 quiet-family suppression >= F0 - 1 row per
  category at both configs. Failing = the fix broke abstention, which is
  the envelope's main measured value; such an arm is refuted regardless
  of E1.
- E2b OVER-SUPPRESSION: F1/F2 must keep speaking where speech is
  required — explicit-rejection and material-change families stay at
  F0's rate minus at most one row per family, both configs.
- E3 PRINT: report the print-family rate for all arms. Pre-registered as
  DESCRIPTIVE (the dead zone is corpus-wide — measured 1/34, 0/34, 1/34
  for MAIN/J/F0, and both emitted prints landed on WRONG rows — so it is
  not envelope-specific; any gain is a gain over MAIN too, not a
  recovery of parity). Pre-registered OVER-FIRE WATCH: any print on a
  fresh-* / material-change / emergency row is a driver-aware to
  driver-invisible bucket error on critical rows — the most expensive
  failure this design can cause; it is reported first, before any gain.
- E4 FRAMING SAFETY: F2 quality (findingQuality, support) >= F1 - 5pp.
  Terseness that costs quality is refuted even if it is cheaper.

Cost (recorded-payload screen, see below):
- C1 THINKING: F2 mean reasoning tokens <= 0.5 x F0 on realistic
  prefixes. This is the pilot-derived target: F0 thinks 690 mean vs
  MAIN's ~0 on 19-38k prefixes.
- C2 TRAJECTORY: F2 observer/driver ratio - MAIN ratio <= 15pp
  (F0 measured +30pp at opus-high). This is the shape test.
- C3 PER-OBS: report per-observation production-priced cost for all arms
  at both configs; the decision table's cost column.

Gate G1 (the user's call, not mine): if C1/C2 fail but E1/E2 hold, the
envelope's quality is bought at a premium — report the premium with the
quality delta beside it and let Andreas decide.

## Measurement order (cheap first, per house rule)

1. Offline: contract text renders, invariants, fingerprints, byte-
   identity of unchanged units across arms. Zero spend.
2. Fresh-corpus screen, opus-high only, samples 2, MAIN/F0/F1/F2
   (~40 rows). Judged. Reads E1/E2/E4 cheaply before any xhigh spend.
3. Recorded-payload cost screen: replay the 19 frozen pilot payloads
   (2026-08-01-trajectory-pilot) through each arm at opus-high.
   ~$0.60/arm, no driver re-run. Reads C1 directly.
4. Only if 2+3 pass: opus-xhigh confirmation of the winning arm vs MAIN
   and F0 on the fresh corpus + a fresh trajectory for C2.

Abort rules: if step 2 refutes F1 on E2 (abstention regression), stop and
redesign the semantics — do not spend on xhigh. If step 3 shows F2's
thinking unchanged, the framing hypothesis is dead and the cost story
falls back to the trim/length factor alone; say so rather than iterating
silently toward a target.

## Design-panel corrections and honest bets (recorded before data)

1. MECHANISM RESTATED: the defect is finding SELECTION, not dedup. All
   six dev-security-user-only rows route steer (including MAIN); the
   split is on `target` alone — MAIN names the user-actor remedy, the
   envelope arms substitute an agent-actionable one. The envelope's
   "route by who must act" framing turned actionability into a filter on
   WHICH finding gets reported. F1/F2 therefore carry an anti-
   substitution selection clause, not only a dedup carve-out.
2. F1 - F0 is a FOUR-part bundle (dedup carve-out, print definition,
   selection clause, re-liveness clause + preamble fix), not the two the
   original spec named. If F1 breaches E2, the cheapest split is
   preamble-only vs routing-only.
3. HONEST BET, pre-registered: C1 (F2 thinking <= 0.5 x F0) is expected
   to FAIL at F2's +184 input tokens; point estimate 350-550 mean
   (20-50% reduction). The DECISIVE test is directional: F2 thinking
   BELOW F0 despite F2 being 43% longer confirms framing as a real
   lever; F2 >= F0 kills the framing hypothesis and the abort rule fires.
4. Sub-ablation F2-minus (remove only "Decide from what is visible; do
   not deliberate.") runs ONLY if F2 beats F1 on thinking — it isolates
   the one instruction-to-not-reason device from the structural ones.
5. Rubric-adjacency disclosed: the selection clause is adjacent to the
   judge's target comparator wording. It names no answer and contains
   none of {credential, token, revoke, rotate, secret, history, account,
   deployment} (asserted by test). It is validated on the FRESH corpus
   and never scored on dev-security-user-only.

## Anomaly discipline (standing)

Anomaly pass on raw rows before any distillation; every surprise triaged
harness-bug | dataset-label-bug | real-effect before entering a verdict.

## Next isolated factor: DECIDABILITY (Andreas, 2026-08-01, before F3 data)

Hypothesis (his): prompt length is a poor predictor of observation cost;
thinking dominates, and what drives thinking is AMBIGUITY. An instruction
set that is extremely clear and foolproof ("idiotensicher") should reduce
thinking even if it is LONGER.

Supporting evidence already measured (not proof — it motivated the
hypothesis after the fact, so F3 is the test):
- MAIN thinks ~0 on real prefixes and is not merely short: 3 fields,
  120/240-char caps, near-zero degrees of freedom.
- F2 beat F0 by -23% thinking while being 43% LONGER; its distinguishing
  device is the ordered first-match list, i.e. removal of rule-precedence
  ambiguity, not brevity.
- F0's prose leaves precedence implicit, so precedence is re-derived per
  observation.

F3 = F2's semantics, maximum decidability: every rule gets an explicit
decidable test, tie-breaks named, precedence stated for every pair that
can collide, no judgment left implicit. F3 may be LONGER than F2 by
design — that is the point of the test.

- D1 (falsifiable): F3 thinking < F2 thinking on the 19 recorded payloads
  at opus-high AND sol-high. If F3 >= F2 despite higher decidability, the
  ambiguity hypothesis is refuted and length/structure is not the lever
  either; the remaining explanation is contract SHAPE (caps + field
  count), which points at MAIN's grammar, not its envelope.
- D2 (safety): F3 quality gates E1/E2/E2b as F1/F2 did. Decidability that
  buys cost by flattening judgment must not flatten the findings.
- Instrument: recorded-payload replay (thinking is cache-independent;
  cost from replay is NOT comparable to live-fork and is not reported).
