# Severity pooling v2 — pre-registration (2026-08-01, before data)

v1 (SEVERITY-PROBE-RESULTS.md) returned NOT VIABLE: exact severity
agreement 41.7%, below the 50% floor. The failure was diagnosed, not
mysterious, and v2 fixes the three named causes. Zero producer spend
again: judges only.

## What v1 established

1. Judges agree on FACTS, disagree on CONVENTION. Identical mechanism
   descriptions, different grades. Two conventions the anchors never
   specified and each judge supplied differently:
   - reachability discounting (sol grades the mechanism; opus downgrades
     a defect it believes cannot currently be reached),
   - deliverable relevance (opus upgrades a defect in the thing the user
     asked for; sol grades it as ordinary text).
2. The clustering swallowed a multi-defect message: MAIN's p6 names the
   TOCTOU race AND the stranded claim in one sentence; the cluster judge
   created no cluster for the race. MAIN's strongest finding was
   invisible to scoring.
3. The pool was seeded only from what arms said, so an undetected defect
   could never enter the reference set.

## The three fixes

**F1 — DECOMPOSE the judgment. Judges answer facts; the analyst blends.**
No judge is ever asked for "severity" as a single blended verdict.
Per issue, each judge answers three independent questions:
  a. `harmIfExecuted`: assuming this code path runs as written, what is
     the worst plausible outcome? blocking / serious / minor / none.
     Explicitly: DO NOT discount for whether it can currently be
     reached; that is question (b).
  b. `reachable`: can this path execute given the rest of the visible
     code? yes / no / unclear.
  c. `inDeliverable`: is the defect in, or does it break, what the user
     explicitly asked the agent to produce? yes / no.
Blending is done AFTER, by the analyst, and both blends are reported:
  - mechanism score: weight by harmIfExecuted alone (9/3/1/0),
  - practical score: harmIfExecuted downgraded one level when
    `reachable = no`, upgraded one level when `inDeliverable = yes`.
Reporting both is the point: if they rank the arms differently, that is
a finding about what "severe" means, not a metric to hide.

**F2 — NO message clustering. Per-issue membership instead.**
Stage 1: each judge EXTRACTS distinct issue claims from each message; a
message may yield several (MAIN's p6 must yield two). Stage 2: claims are
deduped into candidate issues with multi-membership allowed and the
mapping PRINTED. Stage 3: an arm "found" an issue if any of its messages
yielded a claim mapped to it. A message naming two defects credits both.

**F3 — SEED the pool with the planted defects.** All four enter as
candidate issues whether or not any arm mentioned them, and are judged on
the same three questions as everything else. A planted defect nobody
found scores zero for every arm, which is the correct behaviour and
impossible in v1.

## Pre-registered viability, on the decomposed fields

- **V1 (the gate): exact agreement on `harmIfExecuted` >= 70%.** This is
  the field the whole design rests on and it is now free of the two
  conventions that split v1. Below 60%: severity judging is genuinely
  unstable, STOP for real and say so — no v3.
  Between 60 and 70: report as marginal, name the residual disagreement.
- V2: agreement on `reachable` and `inDeliverable` reported (factual
  questions; expected higher). Not gated.
- V3: pool size with planted seeding (expect >= 12; v1 got 12 candidates
  but only 2 carried weight).
- V4: do the mechanism blend and the practical blend RANK THE ARMS
  DIFFERENTLY? Report both rankings side by side.
- V5: precision signal from v1 worth confirming — MAIN raised 5 issues
  both judges called not-real vs F 2 and F2 1. Report not-real counts per
  arm again.

## Rules carried from v1

Judges never see arm labels or how many arms raised an issue. The
mapping and the raw per-issue labels are printed verbatim. Derived
fields are read against raw text before quoting. Planted-defect
severities are NOT assumed — v1 found both judges rating a planted
defect "serious" rather than the author's assumed blocking.
