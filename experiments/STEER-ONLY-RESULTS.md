# Steer-only vocabulary probe — results (2026-08-02)

Runs `STEER-ONLY-SPEC.md` (pre-registered at c65dc7c before any data).
Basis: recorded pilot payload, point `scheduler/opus-high/a1/r1/6`
(mid prefix, L=20,165), piggyback tail, `adaptive-skip-probe.mjs`,
n=10 samples/cell, 6 variants × opus-high + opus-xhigh. Smoke (1
sample/variant, opus-high) frozen separately, not pooled. Spend $3.55
harness-priced ($0.26 smoke + $1.61 high + $1.68 xhigh), plan-window
metered. Zero errored rows; format validity 120/120.

## The cells

| config | variant | skips | mean think | routing (of 10) |
|---|---|---:|---:|---|
| opus-high | MAIN | 5/10 | 538 | steer 4, queue 4, none 2 |
| opus-high | **MAIN-SO** | **10/10** | **0** | **none 10** |
| opus-high | F2 | 0/10 | 849 | steer 10 |
| opus-high | F2-SO | 0/10 | 947 | steer 10 |
| opus-high | ENUM | 10/10 | 0 | queue 10 |
| opus-high | **ENUM-SO** | **10/10** | **0** | **steer 10** |
| opus-xhigh | MAIN | 3/10 | 633 | steer 6, queue 4 |
| opus-xhigh | **MAIN-SO** | **10/10** | **0** | **none 10** |
| opus-xhigh | F2 | 0/10 | 751 | steer 10 |
| opus-xhigh | F2-SO | 0/10 | 739 | steer 10 |
| opus-xhigh | ENUM | 10/10 | 0 | queue 10 |
| opus-xhigh | **ENUM-SO** | **10/10** | **0** | **steer 10** |

Raw distributions are in the frozen stdout logs; every non-ENUM steer
row thought (574–653 mean pooled), every queue row but one skipped —
the delivery-type coupling replicates in the control cells.

## Verdicts on the pre-registered hypotheses

- **H1 HOLDS at both configs — the funding question.** ENUM-SO skips
  10/10 with mean 0 at opus-high AND opus-xhigh (threshold ≥8/10,
  mean <50). The opus no-thinking anomaly SURVIVES the label switch
  for the enumeration arm. And it survives while ROUTING STEER: 20/20
  ENUM-SO rows deliver `steer` at zero thinking — the first
  zero-thinking steer rows in the program beyond the exporter's single
  one. Reading: deliberation attaches to COMMITTING to a single
  delivery choice (the selection arms justify a decision), not to the
  word steer; ENUM annotates findings and never commits, so the label
  swap is free. That is an interpretation, not a measured mechanism.
- **H2: demotion, in the extreme.** MAIN-SO mean 0 vs MAIN 538/633
  (≤0.67× threshold met) with steer share FALLING (4→0, 6→0).
- **H3: for MAIN the collapse is suppression, not escalation.**
  E (steer-share change) = −0.4 (high) / −0.6 (xhigh);
  D (print+none change) = +0.8 / +1.0. D > E decisively: **MAIN-SO
  went totally silent — 20/20 none across both configs**, dropping
  deliveries MAIN itself routed as steer in the same run. The noop
  reasons hold the steer bar and clear nothing over it ("no
  correctness risk yet", "agent is still reading source files").
  For ENUM the shift is the PROPOSAL WORKING AS INTENDED: E = +1.0
  (queue 10 → steer 10), D = 0, cost unchanged at zero — feedback that
  used to wait in a queue now reaches the driver at its next
  checkpoint. For F2: E = D = 0, thinking unchanged (947 vs 849, 739
  vs 751 — inside the band the framing family always occupies).
- **Spec wording retired (Andreas, 2026-08-02, post-registration):**
  a steer does NOT interrupt the driver — it folds in at the driver's
  next checkpoint. The spec's H3 called escalated steers a
  "false-interrupt implication"; that framing is withdrawn. Escalation
  to steer is not a disruption cost. The genuine measured concerns are
  MAIN-SO's silence, thinking-cost changes (none found), and
  quiet-span steers, which are UNNEEDED FEEDBACK, not interrupts.
- **H4 HOLDS.** 120/120 rows parse; no SO row emitted `queue`.

## Anomaly pass (raw rows read before distillation)

1. MAIN-SO's total silence — real-effect, not harness: responses are
   well-formed noops with bar-holding reasons; the same payload in the
   same run drew 8–10 deliveries from MAIN. Scope honestly: ONE
   doc-writing observation point; at a moment with a live blocker
   MAIN-SO might clear its bar. Unmeasured here.
2. ENUM-SO steering at zero thinking (20/20) — real-effect; breaks
   the "steer always thinks" coupling, which now reads as a property
   of SELECTION arms, not of the label.
3. MAIN delivered 10/10 at xhigh vs 8/10 at high with skip 3/10 vs
   5/10 — the established stochastic skip, no triage needed.

## What this means for the benchmark and the runtime proposal

- **The queue-removal proposal is SAFE for enumeration-shaped
  contracts and HARMFUL for selection-shaped ones, on this evidence.**
  ENUM absorbs the collapse at zero cost premium; MAIN under the
  collapsed vocabulary stops delivering at all — a capability loss,
  not a saving (its zero thinking is the silence of never speaking).
  F2 is indifferent but was already the expensive arm.
- The benchmark should carry **ENUM-SO** as an arm (the proposed
  runtime shape at ENUM's price) alongside ENUM; carrying MAIN-SO
  forward as a live-trajectory arm is the direct test of whether the
  silence generalises beyond this point — cheap to include, and the
  suppression risk is exactly what a trajectory with a quiet span and
  a live blocker measures.
- A runtime that removes queue does NOT need a code branch either
  way: both vocabularies are instruction text over the same footer
  parser (`steer` remains a valid label; `queue` simply stops being
  offered), so the branch-cost rule is satisfied whichever way the
  benchmark decides.

## Limits

One observation point, one task moment (doc-writing), n=10/cell,
recorded-payload basis (absolute dollars are fresh-prefix, not
production cache-riding; thinking/routing are the readable outputs).
The long prefix (L=37,892) was not run — the mid signal is unambiguous
on every hypothesis, so the spec's follow-up trigger did not fire.
