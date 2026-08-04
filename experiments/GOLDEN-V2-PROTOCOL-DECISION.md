# Golden v2 — prospective protocol decision (PROPOSED 2026-08-04, awaiting Andreas)

**Status: nothing here is in force.** The registered freeze bar failed (63/67
novel clusters converged, 94.0%, bar 95%) and the recovery amendment's repair
avenues are exhausted: no fourth round, no majority-as-unanimity conversion, no
deletion, no post-result repair, no denominator change. The four holdouts are
all stable, honest disagreements, so the 95% convergence bar is now
mathematically unreachable. The builder fails closed, exactly as registered.
This memo registers the available prospective options and the exact rule text
for the recommended one, so the decision is one word and its execution
mechanical.

Timing property: no arm has ever been scored against v2 — every capstone
quality cell is deliberately blank and both Opus judge columns are unspent.
A protocol amendment adopted now therefore cannot be tuned toward an arm.

## Option A (recommended) — freeze v2 with terminated dissent carried

Prospective rules, verbatim, to be adopted before any further judge call:

1. Content follows the REGISTERED assemble contract unchanged (v1 precedent):
   a final-round 2–1 split enters at the majority position with
   `consensus: "unresolved"` and the minority position verbatim in `dissent`.
   All four holdouts already sit in the provisional candidate under exactly
   this contract; no new content rule is introduced.
2. The completed precision-pass states land through the existing replacement
   routing: `CL52` (unanimous after repair) replaces `V2-I52`'s record, and
   `CL38` replaces `V2-I38`'s — whose majority moved to non-blocking under the
   repaired statement, so `DISP-o-xd-g03` flips blocking→harmful with Sol's
   blocking position kept verbatim.
3. The wave-2 quality gate is restated prospectively: every novel cluster must
   be ADDRESSED — converged, or terminated as a stable recorded dissent after
   the maximum rounds. Under this rule 67/67 are addressed (63 converged +
   `CL38`, `V2-I02`, `V2-I04`, `V2-I05` terminated). The raw convergence rate
   (63/67, 94.0%) stays in the freeze record as a fact; it is not erased.
4. Nothing else moves: settled labels, rubric, membership, denominators of
   settled questions, and the builder's other fail-closed checks are
   unchanged. The builder recomputes the version hash; no hand-set numbers.

Why this is defensible: the original consensus discipline — iterate until
agreement, record dissent verbatim, never average — is preserved, and the
dissent-carrying representation is the one v1 shipped with. The bar's intent
was to catch a sloppy pool; the four holdouts are properties of genuinely
ambiguous source contracts and one genuine severity judgment, not pool
sloppiness. Three of the four carry Sol doubting the issue is harmful at all
against an Opus+analyst majority; the fourth carries Sol calling blocking
what the other two call harmful.

### Projected effect, computed by a write-free dry run (2026-08-04)

`node experiments/golden-dataset-v2-build.mjs --adopt-decision A --dry-run`
routes the frozen states end-to-end and writes only to a temp dir. Projected
final v2: version `0aadc215658a775b`, **75 active (27 blocking, 48 harmful),
61 recorded rejections** — scheduler 15+25, exporter 9+12, dispatcher 3+11 —
with exactly the four verbatim dissents above plus `RD04` in the rejudge
rejections. Differences vs the provisional candidate `2b0a85843c9be981`: one
tier flip (`DISP-o-xd-g03` blocking→harmful, rule 2), two repaired statements,
one dissent resolved to unanimous. The non-dry run refuses to execute until
this memo carries an `ADOPTED: Option A — <date>` line; that refusal and the
still-failing plain build were both verified on 2026-08-04.

## Option B — keep v1 as the ruler

No protocol change. The capstone scores against v1 (46 active, 17 blocking,
same three tasks). Costs: the 29-issue expansion and its precision work are
demoted to bonus-promotion candidates, and the registered judge columns must
be re-based (they were registered against the provisional v2 basis shown to
Sol), which is itself an amendment of similar size to Option A.

## Option C — v2 dies, v3 later

Fail-closed all the way down. Slowest; nothing is spent and nothing learned
from the expansion is used until a future wave rebuilds it under a bar that
distinguishes honest dissent from non-convergence from the start.

## On approval of Option A

Record the pick by appending a single line to this memo — `ADOPTED: Option A
— <date>` — then run `node experiments/golden-dataset-v2-build.mjs
--adopt-decision A`. The builder freezes v2 under rules 1–4 and emits the
version hash; both pending Opus judge columns run against the frozen basis
(the older 119-finding input at its original `369ed58` judge builder, the
fresh 264-finding input at the current frozen builder); Sol + Opus + analyst
consensus forms without changing the original questions; promotions land
versioned; the registered scoring and 2–3 shakedown iterations follow; the
lock-in table reads from the final iteration only.

## Boundaries

No judge call, producer call, state-changing builder run, or freeze happens on
this memo's authority. Write-free dry runs (temp-dir output only) are
permitted to keep the projection above current. It is a proposal; adoption
requires Andreas's explicit pick, recorded in the `ADOPTED:` line before
execution starts.
