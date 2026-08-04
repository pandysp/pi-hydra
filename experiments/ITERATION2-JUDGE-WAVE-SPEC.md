# Iteration-2 judge wave — dataset v3 + re-judging (SPEC, registered 2026-08-04)

Registered before any judge call, per the standing spend discipline. This wave
executes every judge-spend item the iteration-1 data pass produced
(ITERATION1-DATA-PASS.md lanes A4/A5-staged and B), plus the promotion of the
consensus wave's novel candidates. Its output is golden dataset v3 and the
inputs for the iteration-2 rescore. Sol runs on the OpenAI subscription via
its established transport; Opus runs via `claude -p` (or the verified
`oauth-replay` transport — same verdicts, JUDGE-TRANSPORT-AB-SPEC.md);
the analyst is the coordinator session's agents. All deliberation follows the
v2 consensus protocol as amended by the adopted Option A
(GOLDEN-V2-PROTOCOL-DECISION.md): converged, or terminated as recorded
dissent after the maximum rounds — nothing forced, nothing averaged.

## Order of execution (checkpoint after every numbered step)

1. **Dataset repairs (B2–B4, small):** the three anchor-mismatch records
   (`DISP-o-xd-g03`, `EXP-o-xe-g17` anchor-only; `EXP-o-xe-g21` anchor AND
   statement) and the three statement re-examinations (`EXP-o-xe-g22`,
   `EXP-o-xe-g27`, `SCHED-c-13`). Full three-participant protocol per record;
   statement changes use the precision-pass replacement mechanics (replace
   statement and votes, preserve ids, members, provenance, trails).
2. **Anchor backfill rule (B1):** the portable-anchor rule proposed by the
   data pass (seed bytes or edit-surviving declaration regex, never bytes that
   exist only after one driver's edit) is put to the three participants as a
   RULING-style confirmation; on adoption, the 33 anchor-less records and the
   12 non-portable end-state anchors are backfilled mechanically where the
   rule decides, and through deliberation where it does not. The exporter
   denominator proposal (B5) is judged here as ordinary statement semantics.
3. **Cache-only re-judge (A5, staged in CAPSTONE-JUDGE-SPEC.md):** the 23
   fresh-input cache-only findings, both judges, clarified instruction,
   new builder hash recorded. Versioned follow-up; the frozen iteration-1
   judgments remain immutable.
4. **Old-basis re-judge (A4, staged):** the 12 old-input cache-only findings
   under semantic-v2 at the current builder, both judges; the 12 run-end
   findings remain unjudgeable by construction and stay excluded.
5. **Promotions:** the 67 novel candidates from
   `artifacts/2026-08-04-capstone-consensus` (34 fresh + 33 old) enter the
   established pool→consensus→assemble pipeline as promotion candidates
   (provenance: observer, frame from their run records). Deduplication
   against v2 actives AND recorded rejections first (settled rejections are
   not re-litigated: the `EXP-o-xe-g06` precedent). Batches of ~15 clusters,
   checkpoint per batch, resumable — the v2 interruption is the design
   input here.
6. **Assemble v3:** fold 1–2 and 5 into the builder (base = v2
   `0aadc215658a775b` at its freeze commit), checker green, freeze via the
   established artifact flow, version-bumped rescore of every frozen run
   (the iteration-2 scorer landed in lane A and emits `iteration: 2`).

## Spend and interruption discipline

The promotion step is the largest remaining subscription draw of the program
(order of the v2 wave-2 consensus). Every step checkpoints to disk before and
after each judge batch; a quota interruption terminates the STEP cleanly and
never the wave's earlier steps. If the weekly window dies mid-step, the
recovery is the registered resume path, not improvisation: identical inputs,
only unanswered questions retried.

## Boundaries

No runtime changes. No evaluator changes (the iteration-2 scorer is frozen as
landed by lane A before this wave's first judge call). No metric tuning. The
iteration-1 published numbers stay immutable. Promotion requires both judges
plus the protocol — a coordinator or agent never promotes on its own
authority. The driver-prompt realism probe (pending Andreas's documentation
section) is OUTSIDE this wave and separately registered when its input
arrives.
