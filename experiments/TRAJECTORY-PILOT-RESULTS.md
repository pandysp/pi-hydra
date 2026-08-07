# Trajectory pilot — scheduler x opus-high x MAIN/J/F (2026-08-01)

Phase-0 cost-ruler pilot per TRAJECTORY-COST-SPEC.md (pre-registered
4f96565/dc6df90). One real driver run (19 requests, final context ~38k,
4 scripted prompts), three arms observing live at every production point.
Rows + 19 payload snapshots: ~/scratch/2026-08-01-hydra-trajectory-pilot/
(frozen in experiments/artifacts/2026-08-01-trajectory-pilot/). Zero
provider errors; 3 of 4 run-end points invalidated by the reader/writer
cache assertion (dropped whole per D2; piggyback 15/15 clean).

## Pre-registered verdicts

- T1 (structure): PASS, 45/45 points within +-15% of the price-structure
  formula; per-point ratio rises with L (slope +2.2pp/1k tokens). The
  cost decomposition is validated: per-observation numbers on REALISTIC
  prefixes project to trajectory level.
- T2 (level): MAIN per-head = 33.3% of driver cost as measured
  (N_obs/T=1.00); 27.6% at production-median observation rate (x0.83);
  24.6% at x0.74. Andreas's ~30% field prior is CONFIRMED at L~21k mean.
  Never quote without L and driver output (858/turn) alongside.
- T3 (contrast): F - MAIN = +30.3pp of driver cost (95% CI 17.5-44.5,
  n=16 paired points) — far ABOVE the 5pp bound. J = +42.8pp, WORSE than
  F. The contract premium is material at session scale.

## The mechanism (anomaly pass on raw rows — real effect, not a bug)

No recoveries, no multi-calls, cache-read share 96-98% for all arms. The
premium is pure adaptive thinking: on real 19-38k prefixes at opus-high,
MAIN thinks ~0 (mean 72 tokens, literally 0 on 12/16 points — its terse
capped-JSON contract does not engage adaptive thinking) while J thinks
1013 and F 689 mean tokens/observation (10-14x), with single points up
to 2.5k. The envelope's deliberation premium SCALES WITH PREFIX
RICHNESS — the 800-token frozen screens measured 1.3-1.8x and therefore
understated the real premium by an order of magnitude. Screen-derived
per-obs costs at opus-high (+15%) were a small-prefix artifact: real
per-obs at high is MAIN $0.0172 / F $0.0332 / J $0.0430.

Corrections this forces:
1. "Arm choice is third-order at session scale" (mechanics analysis) is
   REFUTED for the envelope arms: the premium is first-order (+30pp)
   until the thinking is tamed.
2. The J fallback ("thinks less at xhigh") did not transfer to real
   prefixes — J is the most expensive arm here. Demoted.
3. CENTRAL LEVER FOR PHASE 2: contract framing controls whether adaptive
   thinking engages at all. A trim/terseness variant of the envelope
   (explicit anti-deliberation framing) is the sharpened hypothesis, and
   it can be screened against the 19 RECORDED PAYLOADS for ~$0.60/arm
   variant without re-running the driver.

## Known limits / open items

- Quality on real prefixes unmeasured (judge streams unfunded per the
  KPI pivot); the xhigh frozen screens say thinking bought nothing
  there, but the joint answer comes from phase 2 + phase 4.
- Run-end M-write accounting fragile under slow generations (TTL expiry
  between sequential arms) — hardening-build item; piggyback unaffected.
- Ground-truth residual: grep/partial-read chunks showing a declaration
  WITHOUT the defective expression spuriously close liveness windows
  (payload says fixed@8; disk says never fixed). Fix before any
  trajectory-quality use; 4 manual confirmations pending accordingly.
- Single trajectory, single config; levels are a range, not a constant.
