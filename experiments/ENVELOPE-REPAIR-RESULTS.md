# Envelope repair — phase 1 results (2026-08-01)

Pre-registered in ENVELOPE-REPAIR-SPEC.md (commits d9ae0de, 28601c3,
9db1114 — all before data). Arms differ in instruction text only:
MAIN (main's shipped contract) / F0 (current envelope) / F1 (semantic
repair) / F2 (repair + first-match framing). Instrument: hardened harness
(a092cdb). Configs: opus-high, sol-high, sol-xhigh. Judges sol+opus,
unanimous, judgedComplete true in every scored cell.

## The defect is fixed, and the current envelope was the worst arm

Fresh user-actor corpus (8 cases x 2 samples, authored blind to the fix by
two independent agents, adversarially leakage-hunted; the driver states
the FACT, never the REMEDY — the confound that disqualifies the old case).

opus-high, judged (n=12 judged feedback rows/arm):

| Arm | findingQuality | support | target | routing | thinking |
|---|---:|---:|---:|---:|---:|
| MAIN | 91.7 | 100.0 | 91.7 | 56.3 | 197 |
| F0 | 66.7 | 75.0 | 75.0 | 56.3 | 409 |
| F1 | 83.3 | 83.3 | **100.0** | 75.0 | 311 |
| F2 | **91.7** | 91.7 | **100.0** | **81.3** | 289 |

`target` — the metric that carried the entire refutation at opus high AND
xhigh — goes 75 -> 100 for both repaired arms. F2 matches MAIN on finding
quality, beats it by 25pp on routing, and thinks 30% less than F0.

Routing replicates across providers (bucket-correct of 16):

| Config | MAIN | F0 | F1 | F2 |
|---|---:|---:|---:|---:|
| opus-high | 9 | 9 | 12 | **13** |
| sol-high | 5 | 4 | **13** | 12 |
| sol-xhigh | 7 | 3 | **13** | 11 |

F0 is the WORST arm on user-actor routing at every config measured,
including main's own contract. The repair is +8 to +10 rows over F0 on
OpenAI and +3 to +4 on Anthropic.

Print emission (the previously dead channel), user-actor rows of 16:
MAIN 3-6, F0 0-3, F1 9-10, F2 7-11. The channel works now; it did not
before, for any arm.

## Pre-registered gates

- E1 (repair): PASS for F2 (91.7 >= MAIN 91.7). FAIL for F1 as literally
  written (83.3 < 91.7) — F1's shortfall is entirely `support`, not
  `target`, and is one row at n=12. Reported both ways; not rewritten.
- E2 (quiet suppression, opus-high): PASS. MAIN 2/8, F0 6/8, F1 5/8
  (-1, inside the bar), F2 6/8 (= F0).
- E2b (must-speak): PASS, 8/8 for every arm — no arm went silent on
  explicit-rejection, material-change, fresh, or emergency rows.
- E3 print over-fire watch: ZERO prints on fresh/material-change/
  emergency rows at any config. The pre-registered worst failure mode did
  not occur.
- E4 (framing safety): PASS — F2 quality is ABOVE F1, not below.
- Regression guard replicates on OpenAI: F2 is the best arm at both sol
  configs (14/16 sol-high, 13/16 sol-xhigh vs MAIN 9 and 8).

## Cost: framing is a real lever; the semantic repair is thinking-neutral

C1, 19 recorded real driver payloads (19-38k prefixes), opus-high:

| Arm | thinking | vs F0 |
|---|---:|---:|
| MAIN | 59 | — |
| F0 | 663 | — |
| F1 | 691 | +4% |
| F2 | **511** | **-23%** |

- C1 formal bar (F2 <= 0.5 x F0) FAILS, exactly as pre-registered in the
  honest bet (predicted 350-550; measured 511).
- The pre-registered DECISIVE test PASSES: F2 thinks 23% less than F0
  while being 43% LONGER. Framing is causal; length is not the driver.
- The semantic repair alone is thinking-neutral (F1 = F0 + 4%): quality
  fixes do not cost deliberation.
- MAIN still thinks ~10x less than any envelope arm. That gap is
  structural and unexplained by framing alone — it motivates F3
  (decidability, pre-registered 9db1114).

Replay cost caveat: a replayed observation does not share the live
driver's cache lineage, so REPLAY COST is not comparable to live-fork
cost and is not reported. Thinking is cache-independent and stands.

## Anomaly pass (raw rows, before this distillation)

- The two fresh expected-none guards are CONTESTED LABELS, not
  over-firing: on both, every arm INCLUDING MAIN and F0 raises a
  different, still-live, agent-actionable finding rather than re-raising
  the handled one (on the mailed-batch case all four arms warn that the
  July run repeats an unauthorized live call, which the user's "I already
  have this one" does not cover). Dataset-label branch of the triage;
  the established quiet families carry E2 instead.
- One sol judge batch failed, leaving 3 rows unjudged; judgedComplete
  correctly refused to score the cell until the metric was re-run.
- A docs-only commit mid-run tripped the resume guard's codeCommit
  comparison (correct but over-strict; filed in the spec).

## Open

- opus-xhigh confirmation of F2 vs MAIN/F0 (spec step 4).
- C2 live-fork trajectory ratio with F2 (running).
- F3 decidability probe (Andreas's hypothesis: ambiguity, not length,
  drives thinking).
- Judged quality for the sol configs (routing only so far).

## C2 — live-fork trajectory ratio (the headline KPI)

One driver run (scheduler, opus-high, 19 points), three arms paired at
identical observation points. Rows: ~/scratch/2026-08-01-hydra-c2-trajectory.

| Arm | observer $ / driver $ | observer $ | marginal vs MAIN |
|---|---:|---:|---:|
| MAIN | **32.1%** | $0.3190 | — |
| F0 | 67.2% | $0.6689 | +$0.3499 |
| F2 | **58.6%** | $0.5836 | +$0.2646 |

- MAIN's baseline REPLICATES (32.1% here vs 33.3% in the pilot, different
  driver run) — the instrument is stable and Andreas's ~30% field prior
  holds at this trajectory length.
- F2 cuts the envelope's trajectory premium from +35.2pp to +26.5pp
  (-25% of the premium).
- C2 pre-registered bar (F2 - MAIN <= 15pp): **FAILS** at 26.5pp.
  Reported as registered; no goalposts moved.
- Deliveries: MAIN 10, F0 9, F2 9 — the repaired arm is not talking more,
  it is talking better (see the quality table above).

Consequence: after the repair, quality is fixed and routing is far
better, but the cost SHAPE still does not meet the bar at opus-high.
The remaining lever is decidability (F3, pre-registered 9db1114); if it
does not close the gap, G1 is a genuine judgment call with the premium
and the quality delta both on the table.
