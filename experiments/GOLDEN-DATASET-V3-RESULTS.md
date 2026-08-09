# Golden dataset v3 — iteration-2 fold results

Version `d176183abab2d211` — **75 active issues (26 blocking, 49 harmful), 61
recorded rejections, checker 8/8**, folded 2026-08-05 from v2
`0aadc215658a775b` by `golden-dataset-v3-fold.mjs`. Ledger row
`2026-08-05-golden-dataset-v3-fold`; freeze artifact
`experiments/artifacts/2026-08-05-golden-dataset-v3/` (lean form: one hashed
tar bundle of all 43 build inputs plus a per-file sha256 provenance manifest).
Commits `d8708d2` (fold + resolver) and `c54120c` (freeze + status docs).

## What was folded

Andreas decided both recovery gates on 2026-08-05: fold now, and complete the
six-record residue. The fold applied the 27 byte-verified settled outcomes
from the iteration-2 wave (`settled-outcomes.json`, sha in the freeze
provenance):

- **Statement replacements** RG22 and RG27 on `EXP-o-xe-g22` / `EXP-o-xe-g27`,
  with votes replaced and the previous statements preserved under
  `precisionRepair`. RG22 is unanimously harmful, so `EXP-o-xe-g22` drops
  from blocking to harmful — the only tier change (27 -> 26 blocking).
- **RG21 Option-A termination** on `EXP-o-xe-g21`: majority blocking/severe,
  sol's non-blocking dissent carried verbatim, consensus recorded as
  unresolved.
- **RULE-ANCHOR-V2 adoption**, stored verbatim at the dataset top level
  (`anchorRule`) with provenance.
- **23 anchor adoptions**: repairs AG03 (`DISP-o-xd-g03`) and AG17
  (`EXP-o-xe-g17`, the first two-sided doc-staleness anchor) plus 21
  backfills, 16 active records remain anchor-less pending the blinded queue
  and future backfills.

The resolver (`golden-dataset-frame-sources.mjs`) implements the adopted
rule's forms: session-frame records may carry seed-state anchors, emergent
anchors resolve against the session end state, and two-sided predicates check
code and doc byte-sides independently. Covered by dedicated tests.

## The six-record residue (completed under the frozen old protocol)

Sol resumed all six from its checkpoint (zero provider calls); Opus answered
the byte-identical prompt (hash `78795420d9…` preserved from the checkpointed
session-limit failure). Result: **BF-d11, BF-d37, BF-d44, BF-g22R ratified
unanimously; BF-d39 and BF-g21R carry substantive opus objections** and
route to the blinded queue with no further persuasion rounds.
`backfill-proposals.json` holds STALE pre-correction anchors for these
records; the voted question blobs in `consensus-backfill-v2/issues.json`
(preserved in the freeze bundle) are the only authoritative source.

## Byte-verification: votes do not override bytes

The settled-outcomes generator now byte-verifies every anchor against the
frozen frame sources before it may fold. Two unanimously voted anchors were
refuted:

- **BF-d44**: its absence witness `leaseExpiresAt: 0` exists in the seed
  `scheduler.js` (in `complete()`'s done-path) — the round's "verified byte
  lookup" claim was false and all three participants ratified on top of it.
- **SCHED-r-d35** (first-round adoption): pins the literal `# Scheduling`
  where the seed doc's title is `# Scheduler` — the anchor never resolves.

Both route to the blinded queue instead of the catalog.

## The blinded human queue (11 items)

`AC13B`, `SCHED-c-15`, `DISP-o-xd-g20`, `DISP-o-xd-g26`, `SCHED-o-g07`,
`SCHED-o-g14`, `SCHED-r-d18`, `BF-d39`, `BF-g21R`, `BF-d44`, `SCHED-r-d35`.
`EXP-o-xe-g21` keeps its v2 anchor until the BF-g21R ruling. Two items are
pre-triaged for a fast ruling: `SCHED-r-d35` is mechanically correctable
(one token, `# Scheduling` -> `# Scheduler`); `BF-d44` needs a
function-scoped anchor design the current rule cannot express. The queue is
ruled by Andreas from blinded evidence (per `JUDGE-DESIGN-SELECTED.md`);
rulings enter the catalog at the next version boundary and are recorded in
that fold's freeze artifact.

## Anchor-resolution semantics (registered; awaiting Andreas's ratification)

The fold forced three resolution rules that RULE-ANCHOR-V2's text implies
but does not spell out. They are implemented identically in the reference
checker (`golden-dataset-frame-sources.mjs`) and the scoring-time liveness
path (`capstone-score.mjs#anchorLiveAtPoint`, with tests), and are recorded
here as one reviewable decision because they bind future denominators:

1. `state: "emergent"` resolves against the session END state (checker) and
   through the gap-claim path at scoring time: no declaration match means
   "unknown" (no anchor to stand on), declaration plus absent repair tokens
   means live, declaration plus a repair token means fixed. All four
   ratified emergent anchors resolve at end and fail at start, so end-only
   is what was actually voted.
2. A session-frame record may carry a `state: "seed"` anchor (the rule's
   whole point: pin only seed bytes or surviving declarations); it resolves
   against the seed files.
3. `match: "two-sided"` is live only while BOTH byte-sides hold (code
   construct present AND stale doc assertion still contradicting); either
   side repaired means fixed; a missing file means unknown.

Nothing recorded is sensitive to the end-vs-either choice in rule 1 today;
if Andreas prefers "either", the change is one line in each path with no
recorded number moving.

## V3 sample rescore completed — 2026-08-09

Any catalog change creates a fresh judge checkpoint identity: the 45-finding
expanded-2Q mechanics sample run against v2 cannot pool with this v3 output.
The checkpoint bases match exactly across judges: protocol, builder, replay
transform, prompt system hash, catalogs, source rows, payload archive, and the
20 frozen sample points.

- Sol completed 45/45 findings in 20 initial batches: zero corrections, invalid
  outputs, or unjudgeable findings.
- Opus completed 42/45 findings. One three-finding point returned a `toolUse`
  provider stop once. Registered policy makes a non-terminal provider stop
  terminal-invalid and ineligible for format correction, so it was not retried
  into a favorable answer. Its 25 attempts comprise 22 initial attempts
  (including two timeout failures at a different point) and three successful
  format-correction attempts.
- Reconciliation found 34 exact agreements, eight disagreements, 23 agreed
  catalog-growth candidates, zero agreed-unclear cases, and three terminal
  invalids. The deterministic public audit sampled 5/11 matched agreements and
  5/23 catalog misses across all three tasks and reproduced byte-identically.

Among the 42 findings with two valid v3 answers, exact agreement is 34/42
(81.0%); the same subset had 32/42 under v2. This is not a prompt result: the
prompt was unchanged and the catalog changed. All eight current disagreements
still require a semantic ruling, dominated by requested-test/process-advice
wording and documentation reachability. No catalog growth or arm score has
been applied. Frozen evidence and the ledger row are
`2026-08-09-expanded-2q-v3-rescore`.

Every previously recorded score in `DECISION-TABLE.md` remains v2/v1 history.
