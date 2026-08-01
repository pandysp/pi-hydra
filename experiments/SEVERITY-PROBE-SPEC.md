# Severity-pooling probe — pre-registration (2026-08-01, before data)

A CHEAP first look at replacing binary hit/miss scoring with
severity-weighted recall over a pooled reference set. NOT a shipped
metric: a probe whose job is to find out whether the design is viable
before anything is built on it.

## Why

Andreas: what matters is that observers find the REAL and SEVERE issues;
missing a top finding is worse than missing a minor one. Current scoring
is one expected finding per case, binary, severity-blind. Proposed
replacement is IR-standard: pool everything every arm found, judge each
distinct issue ONCE (real? how severe?), score arms by severity-weighted
recall over the pooled set. Extra real findings are recall, not bonus
points, so spraying is not rewarded.

## The one question this probe must answer

**P1 (viability): do two independent judges agree on severity?**
Weighted agreement on a 4-level anchored scale over the pooled issues.
- If exact agreement is >= 70% and adjacent-or-better >= 90%, severity
  weighting is viable; build it.
- If exact agreement < 50%, the design is NOT viable as specified — say
  so and stop; do not fall back to averaging two unreliable labels.
- Between: report the disagreement cases verbatim; the scale's anchors
  are the suspect, not the idea.

Secondary, reported but not gating:
- P2: does severity-weighted recall RANK the arms differently than the
  binary keyword scoring did? (It should — that is the point.)
- P3: how many distinct issues does the pool contain vs the 4 planted?
  (Measures how much the planted-only view was missing.)
- P4: top-finding hit rate — did each arm catch the single most severe
  issue the pool contains?

## Design

Input: the C2 trajectory rows (~/scratch/2026-08-01-hydra-c2-trajectory),
3 arms x ~9-10 delivered messages = 28 messages. No new producer spend.

1. POOL: extract every delivered message with its arm and point.
2. DEDUPE into distinct claimed issues. Deduping is done by a judge and
   the clustering is PRINTED for inspection — a bad merge silently
   changes every downstream number.
3. JUDGE each distinct issue independently by sol and opus, blind to
   which arm(s) produced it, against the visible code:
   - real: is this a genuine defect evidenced by the visible material?
   - severity: blocking (9) / serious (3) / minor (1) / not-an-issue (0),
     with the anchors written into the prompt.
4. SCORE each arm: severity-weighted recall = sum of weights of pooled
   issues that arm surfaced / sum of weights of all real pooled issues.
   Plus top-finding hit and severity-weighted precision.

## Rules

- Judges never see the arm label, and never see how many arms found an
  issue (that would leak popularity into severity).
- The planted defects enter the pool like any other issue and are judged
  on the same scale — no privileged status. If judges rate a planted
  defect "minor", that is a finding about the corpus.
- Report the pool with every issue's two severity labels verbatim, so the
  disagreements are inspectable rather than averaged away.
- Derived fields are read against raw text before being quoted
  (the 96eff06 lesson).
- Budget: judges are subscription-billed; producer spend is ZERO. If any
  step needs new producer calls, stop and re-scope.
