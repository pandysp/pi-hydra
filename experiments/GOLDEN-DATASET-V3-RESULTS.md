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
`EXP-o-xe-g21` keeps its v2 anchor until the BF-g21R ruling.

## What this changes downstream

Any catalog change creates a fresh judge checkpoint identity: the 45-finding
expanded-2Q mechanics sample (run against v2) cannot pool with v3 output. The
Opus half of the v3 rescore has run (42/45 judged, one point terminally
invalid on a new `toolUse` stop class); the Sol half and reconciliation wait
on provider quota, and the ledger row for that pair lands when both exist.
Every previously recorded score in `DECISION-TABLE.md` remains v2/v1 history.
