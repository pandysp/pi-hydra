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

1. A novel cluster whose deliberation reached the three-round maximum with all
   participants agreeing the issue is real and harmful, splitting only on
   tier, enters the dataset at the tier all participants share:
   `blocking=false`, `anyHarm=true`, plus `tierContested=true` and the final
   positions verbatim. It counts in any-harm recall and is absent from every
   arm's blocking denominator equally. Applies to `CL38`. A later unanimous
   tier resolution goes through the existing versioned promotion path.
2. A cluster terminating with unresolved existence or ownership disagreement
   is rejected with all dissent recorded verbatim — the same treatment v1 gave
   `RD04`. Applies to `V2-I02`, `V2-I04`, `V2-I05`.
3. The wave-2 quality gate is restated prospectively: every novel cluster must
   be ADDRESSED — converged, or terminated under rules 1–2. Under this rule
   67/67 are addressed. The raw convergence rate (63/67, 94.0%) stays in the
   freeze record as a fact; it is not erased or restated.
4. Nothing else moves: settled labels, rubric, membership, denominators of
   settled questions, and the builder's fail-closed checks are unchanged. The
   builder recomputes the version hash; no hand-set numbers.

Why this is defensible: the original consensus discipline — iterate until
agreement, record dissent verbatim, never average — is preserved. The
contested item scores only where all three participants already agree
(harmful), which is the floor, not an average, and coincides with no arm's
advantage because the exclusion from blocking credit applies to every arm
identically. The bar's intent was to catch a sloppy pool; the four holdouts
are properties of genuinely ambiguous source contracts and one genuine
severity judgment, not pool sloppiness.

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

The builder freezes v2 under rules 1–4 and emits the new version hash; both
pending Opus judge columns run against the frozen basis (the older 119-finding
input at its original `369ed58` judge builder, the fresh 264-finding input at
the current frozen builder); Sol + Opus + analyst consensus forms without
changing the original questions; promotions land versioned; the registered
scoring and 2–3 shakedown iterations follow; the lock-in table reads from the
final iteration only.

## Boundaries

No judge call, producer call, builder run, or freeze happens on this memo's
authority. It is a proposal; adoption requires Andreas's explicit pick, which
should be recorded here with its date before execution starts.
