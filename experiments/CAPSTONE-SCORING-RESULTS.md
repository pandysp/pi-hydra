# Capstone scoring — ITERATION 1 (SHAKEDOWN, 2026-08-04)

**Data pass completed (ITERATION1-DATA-PASS.md):** the registered step-2 read is done; its verdicts qualify several numbers below (intersection-credit floor, per-arm precision units, cache-policy asymmetry, fresh-vs-old basis differences) and supply the iteration-2 work list. Read it before quoting any cell.

**This is not a lock-in table.** Per the registered iteration protocol
(BENCHMARK-SPEC.md) this is the first of 2–3 shakedown passes; its job is to
surface dataset and harness defects as much as to rank arms. The surprise
list below feeds the registered look-at-the-data pass. Metric and dataset
frozen for this iteration: golden v2 `0aadc215658a775b` (75 active / 27
blocking), consensus artifact `2026-08-04-capstone-consensus`, scorer
`capstone-score.mjs` (deterministic, zero provider calls).

Both judges stand behind every "real" and every catalog credit: a finding
counts only when Sol and Opus independently support the same wrong behavior,
and a catalog id only when both matched it (intersection). Disagreements are
recorded, never averaged.

## Fresh input — MAIN-SO2 vs ENUM-SO2 (the steer-only generation)

| task | config | arm | cost / observation | observer / driver | blocking recall | any-harm recall | precision | absolute noise | quiet-span deliveries | weighted recall* |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| scheduler | sol-high | MAIN-SO2 | $0.0253 | 54.5% | 5/15 (33.3%) | 9/40 (22.5%) | 11/17 (64.7%) | 6 | 0† | 14/55 (25.5%) |
| scheduler | sol-high | ENUM-SO2 | $0.0298 | 76.3% | 2/15 (13.3%) | 11/40 (27.5%) | 21/25 (84.0%) | 4 | 0† | 13/55 (23.6%) |
| scheduler | sol-xhigh | MAIN-SO2 | $0.0284 | 58.1% | 5/15 (33.3%) | 11/40 (27.5%) | 15/18 (83.3%) | 3 | 0† | 16/55 (29.1%) |
| scheduler | sol-xhigh | ENUM-SO2 | $0.0439 | 94.0% | 7/15 (46.7%) | 13/40 (32.5%) | 37/41 (90.2%) | 4 | 0† | 20/55 (36.4%) |
| exporter | sol-high | MAIN-SO2 | $0.0276 | 48.3% | 1/7 (14.3%) | 2/18 (11.1%) | 4/8 (50.0%) | 4 | 0† | 3/25 (12.0%) |
| exporter | sol-high | ENUM-SO2 | $0.0381 | 66.7% | 3/7 (42.9%) | 5/18 (27.8%) | 9/14 (64.3%) | 5 | 0† | 8/25 (32.0%) |
| exporter | sol-xhigh | MAIN-SO2 | $0.0210 | 54.8% | 2/6 (33.3%) | 6/18 (33.3%) | 9/12 (75.0%) | 3 | 0† | 8/24 (33.3%) |
| exporter | sol-xhigh | ENUM-SO2 | $0.0302 | 73.3% | 2/6 (33.3%) | 5/18 (27.8%) | 12/16 (75.0%) | 4 | 0† | 7/24 (29.2%) |
| dispatcher | sol-high | MAIN-SO2 | $0.0200 | 61.7% | 1/3 (33.3%) | 3/12 (25.0%) | 14/21 (66.7%) | 7 | 0† | 4/15 (26.7%) |
| dispatcher | sol-high | ENUM-SO2 | $0.0273 | 84.4% | 1/3 (33.3%) | 4/12 (33.3%) | 31/38 (81.6%) | 7 | 0† | 5/15 (33.3%) |
| dispatcher | sol-xhigh | MAIN-SO2 | $0.0298 | 41.7% | 1/3 (33.3%) | 3/12 (25.0%) | 15/19 (78.9%) | 4 | 0† | 4/15 (26.7%) |
| dispatcher | sol-xhigh | ENUM-SO2 | $0.0425 | 65.7% | 2/3 (66.7%) | 5/12 (41.7%) | 31/35 (88.6%) | 4 | 0† | 7/15 (46.7%) |

Unweighted per-task means (labelled as such; denominators differ per task,
never summed): MAIN-SO2 blocking 30.2%, any-harm 24.1%, precision 69.8% ·
ENUM-SO2 blocking 39.4%, any-harm 31.8%, precision 80.6%.

## Old input — MAIN vs F2 vs ENUM (the previous generation, scheduler only)

| task | config | arm | cost / observation | observer / driver | blocking recall | any-harm recall | precision | absolute noise | quiet-span deliveries | weighted recall* |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| scheduler | sol-high | MAIN | $0.0212 | 51.1% | 3/15 (20.0%) | 6/39 (15.4%) | 9/11 (81.8%) | 2 | 0† | 9/54 (16.7%) |
| scheduler | sol-high | F2 | $0.0223 | 57.3% | 3/15 (20.0%) | 6/39 (15.4%) | 12/15 (80.0%) | 3 | 0† | 9/54 (16.7%) |
| scheduler | sol-high | ENUM | $0.0270 | 69.1% | 6/15 (40.0%) | 10/39 (25.6%) | 29/34 (85.3%) | 5 | 0† | 16/54 (29.6%) |
| scheduler | sol-xhigh | MAIN | $0.0269 | 58.7% | 4/15 (26.7%) | 8/40 (20.0%) | 8/9 (88.9%) | 1 | 0† | 12/55 (21.8%) |
| scheduler | sol-xhigh | F2 | $0.0293 | 64.0% | 2/15 (13.3%) | 4/40 (10.0%) | 10/11 (90.9%) | 1 | 0† | 6/55 (10.9%) |
| scheduler | sol-xhigh | ENUM | $0.0401 | 87.5% | 8/15 (53.3%) | 15/40 (37.5%) | 24/27 (88.9%) | 3 | 0† | 23/55 (41.8%) |

Unweighted means: MAIN blocking 23.3%, any-harm 17.7%, precision 85.4% · F2
blocking 16.7%, any-harm 12.7%, precision 85.5% · ENUM blocking 46.7%,
any-harm 31.6%, precision 87.1%.

\* Convenience column only; verdict sentences cite the separate columns.
† Vacuous this iteration — see surprise 1: no measurable quiet span exists
under the files-basis derivation, so the column records zero by construction,
not "no unneeded deliveries".

## Reading, per the registered rules (blocking outranks lexicographically)

- **Scheduler, fresh:** at sol-xhigh ENUM-SO2 found strictly more blocking
  issues (7/15 vs 5/15) and leads every other column except cost (94.0% vs
  58.1% of driver cost). At sol-high the order REVERSES on blocking recall:
  MAIN-SO2 5/15 vs ENUM-SO2 2/15 — an effort-dependent reversal that echoes
  nothing in the Anthropic data and is surprise 5 below.
- **Exporter:** sol-high ENUM-SO2 strictly ahead on blocking (3/7 vs 1/7);
  sol-xhigh tied 2/6 — verdict falls to any-harm (33.3% MAIN vs 27.8% ENUM),
  precision (75.0% both), and cost (MAIN cheaper) → MAIN-SO2 edges the tie.
- **Dispatcher:** sol-high tied 1/3; sol-xhigh ENUM-SO2 ahead (2/3 vs 1/3)
  at nearly twice the precision volume (31 real vs 15).
- **Generations (scheduler, same judges and dataset):** ENUM-SO2 fresh at
  sol-xhigh (7/15, 90.2% precision, 94.0% cost ratio) sits close to old ENUM
  (8/15, 88.9%, 87.5%) — the steer-only collapse did not damage ENUM's
  recall. F2 is dominated everywhere and remains dead. Old MAIN's precision
  (81.8–88.9%) is notably above fresh MAIN-SO2's scheduler sol-high 64.7% —
  surprise 6.
- **Cost stands apart:** MAIN-SO2 is the cheaper observer in every cell
  ($0.020–0.030/obs, 42–62% of driver) vs ENUM-SO2 ($0.027–0.044, 66–94%).
  No fusion with quality; both columns quoted wherever a verdict is stated.

## Basis and derivations (exactly how the numbers were computed)

- **Credit:** a finding is real iff ≥1 consensus defect with `credited=true`
  (both judges support the same wrong behavior, adversarially verified, 7
  analyst resolutions recorded in-band). Catalog credit = intersection of
  both judges' matches, tiered by FINAL v2 — the registered versioned
  follow-up over the provisional basis shown to the judges; its one material
  tier change is `DISP-o-xd-g03` blocking→harmful.
- **Denominators:** per cell (task×config trajectory shared by all arms):
  active issues of the task, minus issues whose anchor never matches any
  per-point workspace snapshot (files derivation), plus cell-wide
  re-admission of credited-but-"never-live" ids (see surprise 3). 33 of 75
  active issues carry no anchors at all (v1-era grandfathered records) —
  their liveness is mechanically unresolvable and they stay in every
  denominator of their task, flagged (surprise 4). Net exclusions:
  dispatcher −2 (`DISP-o-xd-g24`, `DISP-o-xd-g11`), exporter −3
  (`EXP-o-xe-g22`, `EXP-o-xe-g27`, plus one of g17/g21 per config), old
  scheduler sol-high −1 (`SCHED-c-ru13b`).
- **Absolute noise** = raised − real per the frozen renderer, which counts
  one-judge disagreements as noise. The stricter both-judges-not-real counts
  are: fresh scheduler 3/1/1/1, exporter 2/4/1/2, dispatcher 2/2/1/1; old
  1/1/2/0/0/2 (cell order as in the tables) — surprise 2 records the
  wording/renderer mismatch for the versioned evaluator follow-up.
- **Quiet spans:** files-basis; every cell's span set is empty (planted
  defects live from point 0), so the column is vacuous this iteration.

## Surprise list for the registered data pass (triage per protocol)

1. **harness-bug — payload liveness walker blind on capstone payloads.**
   `defectStateInPayload` finds no authoritative chunks in the capstone
   runner's Responses-API payload shape, while the defective expressions are
   demonstrably inside the payload bytes (verified by direct string search).
   The registered payload-primary liveness and the real quiet-span metric
   are therefore unavailable this iteration (files-basis substituted,
   documented above). Fix the walker, re-derive, re-score for iteration 2.
2. **evaluator wording vs renderer — "absolute noise".** The registered
   metric text says both-judges-not-real; the frozen renderer derives
   raised−real (includes one-judge disagreements). Both reported this
   iteration; reconcile as a versioned evaluator follow-up, not an in-place
   edit.
3. **dataset-label-bug candidates — anchors that never match the seed.**
   `DISP-o-xd-g03` (both configs), `EXP-o-xe-g17` (sol-xhigh),
   `EXP-o-xe-g21` (sol-high) are credited by BOTH judges yet their anchors
   match no workspace snapshot, including point 0 — the anchor bytes, not
   the issues, look wrong. Anchor repair via the consensus protocol.
4. **dataset hygiene — 33 anchor-less active records** (v1-era) make
   mechanical liveness impossible for 44% of the catalog. Anchor backfill
   is the single highest-leverage dataset fix for iteration 2.
5. **real-effect candidate — effort-dependent blocking reversal on the
   scheduler (fresh):** ENUM-SO2 2/15 at sol-high vs 7/15 at sol-xhigh while
   MAIN-SO2 holds 5/15 at both. Needs the raw-row read before it is believed
   (which blockers, which deliveries, cache validity).
6. **real-effect candidate — fresh MAIN-SO2 scheduler sol-high precision
   64.7%** vs old MAIN's 81.8% on the same task and judges: possibly the
   SO2 wording change, possibly point-mix; raw-row read required.
7. **eligibility note:** cache-only-invalid observation points contribute
   judgeable findings under the registered semantic-v2 policy; several
   scheduler sol-high MAIN-SO2 non-credits are prescriptive-advice messages
   from exactly those points (both judges extracted zero claims). Recorded
   here so the data pass checks whether the policy, not the arm, drives the
   precision gap in surprise 6.

## Artifacts

Scorer outputs (tables, per-cell details, means, 136 flags) frozen with this
iteration's run under `~/scratch/2026-08-04-capstone-scoring/out/` and
committed in summary form here; the scorer reads only frozen inputs and is
re-runnable byte-for-byte.
