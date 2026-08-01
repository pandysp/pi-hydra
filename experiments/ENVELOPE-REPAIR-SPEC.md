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
- REGRESSION guard set: the 5 quiet-family categories from the screen
  corpus (pending-equivalent, newly-delivered, visible-no-response,
  full-resolution, explicit-rejection) — the envelope's measured win.
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
- E3 PRINT: report the print-family rate for all arms. Pre-registered as
  DESCRIPTIVE (the dead zone is corpus-wide and may be a corpus artifact,
  not a contract defect); a rate that moves is evidence, not a gate.
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

## Anomaly discipline (standing)

Anomaly pass on raw rows before any distillation; every surprise triaged
harness-bug | dataset-label-bug | real-effect before entering a verdict.
