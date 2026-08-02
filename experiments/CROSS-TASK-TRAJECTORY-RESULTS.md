# Cross-task trajectories — exporter & dispatcher (2026-08-02)

Runs B of `ENUM-GENERALISATION-SPEC.md` (question N3, honesty question N4):
do ENUM's cost shape and coverage advantage hold beyond the scheduler?
Live-fork benchmark, `trajectory-cost-ab.mjs`, opus-high, arms MAIN / F2 /
ENUM paired at every production observation point, same settings as the
scheduler reference run (`--max-turns 5`, concurrency 1).

Provenance: the exporter cell completed cleanly in the 2026-08-01 evening
run before the session limit (15 points, zero errors, zero invalid rows,
verified by re-read). The dispatcher cell from that evening was truncated
by an account rate limit (429s reached the DRIVER itself, 2 dropped
points, 5 invalid rows) and was re-run fresh and complete on 2026-08-02;
the truncated attempt is retained in the frozen artifact for the record
and no number below is read from it.

## Cost — the ratios move with the task, the ordering does not

| cell | arm | observer $/driver $ | scheduler baseline |
|---|---|---:|---:|
| exporter/opus-high | MAIN | **47.4%** | 23.0% |
| exporter/opus-high | F2 | 73.5% | 42.6% |
| exporter/opus-high | ENUM | 61.4% | 32.5% |
| dispatcher/opus-high | MAIN | **37.4%** | 23.0% |
| dispatcher/opus-high | F2 | 61.4% | 42.6% |
| dispatcher/opus-high | ENUM | 47.3% | 32.5% |

Exporter validity: 45/45 observation points valid, mean cache-read share
96.2%, T1 fit 33/33 piggyback points within ±15%, driver 15 requests,
final context 38,507 tokens. Driver cost $0.756. Dispatcher validity:
60 observation rows, the only 8 invalid ones are the 4 run-end points
(the known reader/writer cache assertion — dropped whole across all
arms, 16 clean paired points remain), mean cache-read share 96.4%,
driver 20 requests, final context 44,242, driver cost $0.899.

Ratio denominators are NOT comparable across tasks (driver cost moves);
the within-run ordering is the readable result, exactly as the scheduler
run established for cross-run absolutes.

**The ordering MAIN < ENUM < F2 replicates on both new tasks** — three
of three tasks now. ENUM's premium over MAIN: scheduler +9.5pp, exporter
+14.0pp, dispatcher +9.9pp. F2's: +19.6pp, +25.9pp, +24.0pp. ENUM is
cheaper than F2 by 12-24pp of driver cost everywhere.

## The thinking mechanism is TASK-DEPENDENT — the exporter qualifies it

On the scheduler, thinking tracked delivery type near-perfectly (steer
always thought, queue never) and ENUM was zero-thinking on 13/13. On the
exporter, all three arms think more, and the coupling loosens:

| arm | scheduler mean | exporter mean | dispatcher mean |
|---|---:|---:|---:|
| MAIN | ~0 | 294 (10/15 zero) | 143 (15/17 zero) |
| F2 | 579 | 730 (2/15 zero) | 668 (3/17 zero) |
| ENUM | 0 | 330 (13/15 zero) | 43 (16/17 zero) |

Reasoning grouped by routed delivery (exporter):

- Exporter, MAIN: routed ZERO steers yet thought on 5 rows — including
  two `queue` rows at 457 and 1,737 tokens and three `none` rows up to
  1,080. On the scheduler, queue rows thought 0 in 13/13.
- Exporter, ENUM: zero-thinking on 13/15 but spikes on one `print`
  (2,157) and one `queue` (2,790) — and its single `steer` thought ZERO.
- Dispatcher: the coupling mostly RETURNS. ENUM thinks only on its
  single steer (735; all 15 queue rows zero). MAIN thinks on 2 of 12
  queue rows and its one steer. F2's 11 steers all think (mean 840).

So the steer↔thinking coupling that was near-perfect on the scheduler
(28/28 steer-or-print rows thought, 13/13 queue rows skipped) is a
strong tendency, not a law: the exporter loosens it in both directions
(thinking on queue/none, a zero-thinking steer), the dispatcher mostly
restores it. ENUM remains the arm closest to zero-thinking on every
task, but its zero is not unconditional.

F2's cost premium is legibly its INTERVENTION RATE, not its wording: it
routed steer on 7/15 exporter and 11/17 dispatcher observations, and
every steer thinks ~800-1000 tokens for any arm. This is the
delivery-type mechanism's cost story playing out across tasks.

## N4 — contract followed, everywhere measured so far

Exporter: format validity 15/15 for every arm, zero parse errors. ENUM
enumerates 2.80 findings/message (42 findings over 15 delivered
messages); MAIN and F2 sit at exactly 1.00 — the one-finding ceiling,
visible again. ENUM delivered at every point (15/15), F2 12/15, MAIN
5/15.

Dispatcher: ENUM 3.75 findings/message (60 over 16 delivered), MAIN and
F2 at 1.00. Zero parse errors anywhere. The contract is followed in
every cell of both tasks — no broken-arm cells to report.

## False interrupts — first measurable quiet span in the program

Both tasks have measurable quiet spans (exporter points 0–3, dispatcher
0–5, against the 3 required) — the scheduler trajectories never had one.

Exporter: **zero strict false interrupts for every arm** (no steer in
the quiet span). What the span contained: the driver wrote tests it
never executed (the harness gives it no shell tool), F2 printed that to
the user 3×, ENUM queued it 3× (plus a real CR-handling gap at p0),
MAIN stayed silent 4/4.

Dispatcher: **F2 steered twice inside the quiet span** (p3, p5) — the
first strict false-interrupt events in the program. Read, both are
grounded process interventions (tests never run; the driver about to
rewrite docs without having opened the source files it said it would
read), not fabrications — "false" by the planted-defect clock, real by
content. MAIN and ENUM: zero quiet-span steers on both tasks.

ENUM's triple re-raise of the same unrun-tests finding (exporter
p1/p2/p3; again dispatcher p2-p5) is the open-loop repeat pattern made
visible on two more tasks.

## Coverage on the resolved binary axes (per-task pools)

Method: `enum-trajectory-adapt.mjs` renders all three answer shapes as
format-blind prose, `severity-pool-probe-v2.mjs --task <id>` pools every
delivered claim, judges label the two reliable axes (blocking /
anyHarm), read-not-keyword-matched throughout (96eff06 discipline).

Judge agreement in these cells: exporter 92.9% exact / 100% adjacent,
dispatcher 80.6% / 100% (n=28 and 31) — both above every earlier cell,
consistent with SEVERITY-V4.

### Judged pools (issues from these trajectories' own claims + planted seeds)

| task | arm | unanimous-blocking | any-harm | issues raised | both-judges-not-real | precision |
|---|---|---:|---:|---:|---:|---:|
| exporter | MAIN | 0/0 | 2/18 | 4 | 2 | 50% |
| exporter | F2 | 0/0 | 7/18 | 9 | 2 | 78% |
| exporter | **ENUM** | 0/0 | **15/18** | 24 | 8 | 67% |
| dispatcher | MAIN | **2/2** | 5/12 | 11 | 3 | 73% |
| dispatcher | F2 | **2/2** | 5/12 | 8 | 2 | 75% |
| dispatcher | **ENUM** | **2/2** | **10/12** | 28 | 13 | **54%** |

The exporter pool contains ZERO unanimous-blocking issues — both judges
rate all three planted defects serious, not blocking (see the golden-set
discrepancy below). The two dispatcher blockers (the swallowed retry
failure and the un-keyed re-POST) were caught by ALL three arms.

Planted coverage, read not matched: exporter — n-plus-one ENUM+F2,
unbounded-page-size ENUM only, **offset-drift NOBODY**; dispatcher —
swallowed-failure and no-idempotency-key all arms, **retries-client-
errors NOBODY**. Two of six planted defects across the new tasks were
missed by every arm.

### Scored against golden-dataset v1 (version 4ea27b0018705940)

The frozen set's regression scoring, done by reading each pool issue
against the golden statements (RULING 2 individuation):

| task | golden tier | MAIN | F2 | ENUM |
|---|---|---:|---:|---:|
| exporter | blocking (of 3) | 0 | 1 | **2** |
| exporter | harmful (of 2) | 0 | 1 | **2** |
| dispatcher | blocking (of 3) | 2 | 2 | 2 |
| dispatcher | harmful (of 1) | 0 | 0 | 0 |

ENUM alone raised the CR quote-class defect (EXP-c-12) and the
NaN-limit family (EXP-c-11, via two distinct wordings); F2 raised the
NaN-limit header-only variant; MAIN raised no golden exporter record at
all. Nobody raised EXP-offset-drift or DISP-c-03 (the maskCard PAN
leak) — both discovered only by /code-review max, never by an observer.

### DISCREPANCY between this run's judges and golden-dataset v1 — flagged, not resolved

My two-judge pool and the golden set's deliberated consensus disagree
systematically on the exporter, always by exactly one tier at the
serious/blocking boundary: EXP-offset-drift, EXP-c-11 and EXP-c-12 are
blocking in the golden set, serious/serious here. The dispatcher tiers
agree everywhere. SEVERITY-V4 established blocking-vs-rest as the
RELIABLE boundary (90.5%), so a systematic one-sided shift between the
two instruments (independent two-judge labels vs three-participant
deliberation with the two rulings in the rubric) is a calibration gap,
not noise. Neither side is silently preferred: the golden-set table
above uses golden tiers by definition; the judged-pool table uses this
run's labels. Reconciling the instruments is follow-up work.

## Ground truth

Exporter Q0a: PASS — 3/3 defects with liveness windows (visible from
point 4, never fixed), payload/files derivations agree, confirmations
recorded after manually verifying each defective expression present in
both the first and final recorded file states (`fable-fork-crosstask`).

Dispatcher ground truth Q0a: PASS — 3/3 defects visible from point 6,
never fixed, derivations agree, quiet span 6, confirmations recorded
after manually verifying each defective expression in first and final
recorded file states.

## Spend

Exporter (2026-08-01 run): driver $0.756, observers $1.378. Dispatcher
fresh run (2026-08-02): driver $0.899, observers $1.313. The superseded
truncated dispatcher attempt cost ~$1.00 (retained in the artifact, no
number read from it). Judging: subscription-billed, $0 metered. Total
new spend this session: ~$2.21.

## Verdict on N3

**ENUM's shape generalises, with one new cost disclosed.**

1. **Cost ordering holds on 3 of 3 tasks**: MAIN < ENUM < F2, every
   trajectory. ENUM's premium over MAIN: +9.5pp (scheduler), +14.0pp
   (exporter), +9.9pp (dispatcher); it undercuts F2 by 10–14pp of
   driver cost everywhere.
2. **Zero-thinking mostly transfers but is not unconditional**: 13/13
   scheduler, 16/17 dispatcher (thinks only on its one steer —
   delivery-type-consistent), 13/15 exporter with two four-digit spikes
   on queue/print rows.
3. **Coverage advantage holds and widens**: any-harm recall 15/18 and
   10/12 against baselines at 2–7/18 and 5/12; golden blocking-tier
   2/3 exporter (best; MAIN 0/3), tied 2/3 dispatcher. ENUM is the only
   arm that raised golden blockers no baseline saw.
4. **The disclosed cost is precision on the dispatcher: 54%** (13 of 28
   raised issues both-judges-not-real — mostly test-coverage
   micro-complaints about the maskEmail change). On the exporter ENUM
   holds 67% vs MAIN's 50%; the scheduler's "more precise than MAIN"
   does not generalise unconditionally. Recall and noise rise together
   with enumeration volume; whether 13 noisy queue items cost more than
   a missed blocker is a product judgment, and the closed loop (driver
   reaction) is still unmeasured.

Both quiet spans yielded zero strict false interrupts for MAIN and
ENUM; F2 steered twice during the dispatcher's quiet span (grounded
process interventions, judged real by content, "false" only by the
planted-defect clock).
