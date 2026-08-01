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
