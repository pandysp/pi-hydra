# Golden dataset v2 — BUILT (2026-08-04)

> **Superseded as the ruler 2026-08-05** by v3 `d176183abab2d211` (the
> iteration-2 fold, `GOLDEN-DATASET-V3-RESULTS.md`). Everything below stays
> exact as the v2 build record.

Version `0aadc215658a775b` — **75 active issues (27 blocking, 48 harmful),
61 recorded rejections** — built by
`golden-dataset-v2-build.mjs --adopt-decision A` from the frozen consensus
states under `~/scratch/2026-08-02-golden-v2`, on the v1 base
(`4ea27b0018705940` at commit `7eedc8b`). The mechanical checker passes 8/8.

Per task: scheduler 15 blocking + 25 harmful · exporter 9 + 12 ·
dispatcher 3 + 11.

## How it was validated

Both judges (Sol, Opus) plus the analyst deliberated every question: 32 pool
credits onto v1 records, 67 novel clusters, 5 rejudged records, plus the
RULING 4 and editorial confirmation passes. Raw novel convergence is 63/67
(94.0%): 62 unanimous in the base run, CL52 unanimous after its registered
statement repair, and four questions terminated as stable dissent after the
maximum three rounds. That is below the wave's original 95% unanimity bar; the
build is final anyway under the prospectively adopted protocol decision
(`GOLDEN-V2-PROTOCOL-DECISION.md`, Option A, adopted by Andreas 2026-08-04
before any arm was scored against v2): every cluster must be ADDRESSED —
converged, or terminated as recorded dissent. 67/67 are addressed; nothing was
pressured, converted, deleted, or repaired after the fact.

## The carried dissents (verbatim in the dataset)

- `EXP-c-ru08`, `EXP-c-ru06b`, `EXP-r-be2-06` — active harmful; Sol holds
  `anyHarm=false` against an Opus+analyst majority (genuine contract/policy
  ambiguity, repair-ineligible).
- `DISP-o-xd-g03` — active harmful under its precision-repaired statement;
  Sol holds `blocking=true` (attributing the duplicate-payment consequence
  here), Opus and the analyst keep that consequence with the separately
  recorded key-less retry defect.
- `RD04` — rejected (unresolved majority-false) with Opus's individuation
  dissent kept verbatim, per the original rule.

## Differences vs the provisional candidate `2b0a85843c9be981`

One tier flip (`DISP-o-xd-g03` blocking→harmful under the repaired
statement), two precision-repaired statements (`CL38`→`DISP-o-xd-g03`,
`CL52`→`DISP-o-xd-g11`), one dissent resolved to unanimous
(`DISP-o-xd-g11`), and the provisional marker replaced by the recorded
protocol decision in `builtFrom`. The capstone judge basis remains the exact
provisional bytes shown to Sol (frozen in `CAPSTONE-FROZEN-INPUTS.json`);
catalog differences between that basis and this final version are handled as
the registered versioned follow-up during consensus.

## What followed

Both pending OpenAI Opus columns completed on their exact frozen bases, then
Sol + Opus + analyst consensus froze 371 judgeable findings. Iteration 1 scored
all 18 registered cells against this version and the required raw-data pass
found material judge, denominator, and anchor-design weaknesses. The first two
steps of iteration 2 later produced resumable scratch checkpoints but were not
applied before the Opus session limit stopped the run. The live boundary is in
`BENCHMARK-SPEC.md` and `ITERATION2-JUDGE-WAVE-SPEC.md`; no lock-in table exists.
