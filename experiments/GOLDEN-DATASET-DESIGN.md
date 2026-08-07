# Golden dataset — design (2026-08-01, decided by Andreas)

Hybrid: a STABLE authored/curated golden set per task (regression gate,
cross-time comparability) plus a JUDGED BONUS CATEGORY for issues nobody
planted, with fold-back promotion so the set grows from discovery rather
than from authoring sessions.

Judge-alignment work (CONSENSUS-SPEC, SEVERITY-V4-BLOCKING-TIER) serves
BOTH halves: it builds the initial golden set and it governs the bonus
category thereafter.

## Why hybrid (the case each half wins)

Golden set wins on: stability across judge-model upgrades (a frozen set
keeps historical numbers comparable), deterministic millisecond
regression checks with zero API calls, resistance to a contract tuned to
please judges, and severity as a product call rather than a generic one.

Judged bonus wins on: coverage of what we never planted (measured: 17 of
21 real findings sat outside the planted set), scaling to many
trajectories without an authoring bill per task, and — decisively —
**issues the DRIVER introduces mid-run** ("two edits corrupted braces",
"the last doc edit landed truncated"). Those are unplantable by
construction and are among the most valuable things an observer catches.

## Issue schema (one record per issue)

    id                stable slug, never reused
    task              scheduler | exporter | dispatcher | ...
    statement         one sentence, mechanism-level
    anchors           { expression, declaration, identifier } for liveness
    tier              blocking | harmful          (the two RELIABLE axes;
                      never the 4-level scale, 61.9% agreement)
    reachable         whether the defective path is reached in-repo
                      (RULING 1 promised this field; the v1 audit found
                      the pipeline never wrote it — added for v2)
    precondition      caller behavior required to trigger harm, if any
                      (RULING 4; null when the defect fires unaided)
    frame             seed | session — the state the issue is judged
                      against (RULING 3 made mechanical; v1 routed frames
                      by a symptom filter and missed two records)
    provenance        planted | reference-review | promoted
    promotedFrom      runId + date, when provenance = promoted
    votes             { sol, opus, analyst } at promotion time
    firstSeen         runId
    status            active | retired (with reason)

Set version = content hash over all active records, recorded in every
verdict that scores against it.

## Build (initial set per task)

1. PLANTED defects enter as candidates (provenance: planted).
2. REFERENCE REVIEW: a strong model reads the recorded trajectory cold
   and writes the ideal review — every defect it can find. This is the
   ONLY mechanism that catches an issue every arm missed AND we failed to
   plant. (The arm-seeded pool cannot: the lease-clock defect was in our
   pool only because we planted it; nobody described it.)
3. OBSERVER POOL: every distinct claim any arm has ever made on this
   task, from the frozen artifacts.
4. All candidates go through the CONSENSUS PROTOCOL (three participants,
   two binary axes, deliberation to convergence). Issues the three agree
   are real enter the set at their agreed tier; the rest are recorded as
   rejected with the dissent, not deleted.
5. Freeze with a content hash. This is v1.

## Promotion (how the set grows)

A bonus claim from any future run is promoted into the golden set iff:
- both judges agree it is real (>= the `harmful` tier), AND
- it is not already an active record (dedup against statements), AND
- the promoting runId and both votes are recorded on the record.

Promotion bumps the set version. Every past artifact can be re-scored
against the new version for free — every delivered message is frozen.

Guard: promotion requires BOTH judges. A one-judge promotion would let
the set fill with unvetted opinion, and nobody could later tell which
records were vetted how — hence `votes` and `promotedFrom` on the record.

## Scoring

- REGRESSION (cheap, deterministic, every change): matching against the
  frozen set only. Blocking-tier recall + harmful-tier recall. No judges.
- EVALUATION (periodic): the full pipeline — extraction, judging, bonus
  discovery, promotion. Reports golden-set recall AND bonus finds AND
  not-real claims separately, never blended into one score.

## Open, deliberately

- Whether the reference reviewer should see the planted list (it must
  NOT: seeing it would collapse the independent-discovery property).
- How often to re-run the reference review as tasks accumulate runs.
- Whether `harmful` needs splitting later; not now, the middle of the
  scale is where judges disagree.

## Two conventions, RULED (analyst, 2026-08-01, reversible)

Andreas delegated the severity work ("It is your and the two judges'
job"), so these are settled here rather than referred up. Both blocked
real work: the consensus stalled 2-1 on the first, and the reference
review's planted-defect match turned on the second.

**RULING 1 — REACHABILITY.** Rate `harmIfExecuted` as if the code path
runs, and record reachability as a SEPARATE field. **Exported public API
counts as reachable by definition**: a library's callers are not in its
repository, so "nothing in this repo calls it" is not evidence of
unreachability. This resolves the standing 2-1 dissent toward blocking
for the caller-supplied lease expiry, and matches how a reviewer treats a
published function.
Consequence if wrong: we over-weight defects in unused exports. The
separate `reachable` field keeps that visible and re-scorable.

**RULING 2 — INDIVIDUATION.** One issue per DEFECTIVE EXPRESSION, not per
trigger. Same line, same consequence, different input = ONE issue.
(The lease defect described via "omitting `now` yields NaN" and via "a
caller supplies a hostile far-future timestamp" is one defect, not two.)
Consequence if wrong: we under-count when one line genuinely carries two
independent failure modes. Reviewable per issue; the dedup mapping is
printed so a bad merge is visible.

Both rulings are written into the judging prompts, not applied
post-hoc, so labels are produced under them rather than adjusted to them.

**RULING 3 — TEMPORAL FRAME (analyst, 2026-08-02, reversible).** An issue
is judged against the state of the code its statement describes. A
seeded-state defect does not stop being a defect because the driver fixed
it during one recorded session — the fix ends the liveness window, which
scoring already respects; "not present in the end state" is therefore not
grounds for not-real on a seed-era issue. Symmetrically, issues about
driver-written artifacts (`stats`, the doc rewrite) are judged against
the recorded session state, the only state in which they exist.
Surfaced by the v1 build: round-1 judges split exactly along this line
(one judged the seed, one the end state) on every planted defect the
driver later repaired. Not yet in the rubric text — it was argued through
deliberation reasons in round 2; fold it into `RULINGS` before the next
consensus run so labels are produced under it from round 1.
Consequence if wrong: the set over-records defects a real deployment
would never ship (they were fixed in-session). The per-record liveness
windows and `firstSeen` keep that auditable.
2026-08-02 addendum: folded into the rubric text (18b5627). The v1 build
routed frames by a SYMPTOM filter (judges rejecting on driver-repair
reasons), which the audit showed misses the accept direction (a driver
ADDITION manufacturing a defect: SCHED-r-d22) and the silent-concession
case (SCHED-r-d04). v2 routes mechanically: every pool candidate carries
`frame: seed | session` derived from its provenance at pool time.

**RULING 4 — CALLER-SIDE PRECONDITIONS (analyst, 2026-08-02,
reversible).** A defect's tier is rated under the interaction its
statement names, provided the public contract does not forbid that
interaction. "A caller mutates a record it fetched" is part of
as-if-executed, exactly as RULING 1 treats "a caller reaches the
exported function"; the required caller behavior is recorded in the
`precondition` field, separate from the tier, so the discount stays
visible and re-scorable. A precondition the contract explicitly forbids
(a documented "do not mutate") DOES discount — violating a stated
contract is the caller's defect, not this record's.
Surfaced by the v1 audit: the ungoverned discount ("the reference alone
produces no incorrect behavior") carried both standing dissents
(SCHED-r-d20, SCHED-r-d37) and several rejection margins, deciding
labels without ever being ruled. Scope: all labels produced after the
fold, plus ONE confirmation round for the two dissent-carrying records —
the RULING 1 precedent (the C2 lease-clock dissent dissolved the same
way once the convention entered the rubric).
Consequence if wrong: we over-tier defects whose harm requires unusual
but legal caller behavior; `precondition` keeps that auditable.

## Build conventions added by the v1 audit (2026-08-02)

- A source report that bundles independent defective expressions SPLITS
  into multiple pool candidates under RULING 2 (v1's one-report-one-
  cluster contract bundled EXP-c-12's two defects and dropped a
  provenance on SCHED-o-g08).
- Rejection reasons carry a two-value vocabulary: `not a real defect`
  vs `real, individuated onto <id> under RULING 2` (v1 hardcoded the
  first for all 26).
- New records enter with anchors; v1's anchors cover only the 10
  planted records, which is what let a two-defect bundle and a
  mis-scoped statement through the offline guard.
