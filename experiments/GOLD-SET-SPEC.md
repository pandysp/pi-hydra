# Hardened gold set — design (2026-08-01, Andreas)

## The correction

v1/v2/v3 all try to make LLM judges PRODUCE the severity ordering.
Andreas: we should author our own hardened ranking/severity and then
count how many were observed. He is right, and my framing was wrong:
pooled relevance judgment is the technique for when you CANNOT author
the gold set (web search). We SEED the codebase — we can author it.

v1's own numbers say which half is reliable:
  - "is this real": 83.3% judge agreement
  - "how severe":   41.7% judge agreement
Severity is the unreliable elicitation; MATCHING is the reliable one.
So: author severity, judge only matching.

## The design

**1. GOLD SET (authored once, frozen).** Per seeded task, every defect
gets: id, one-line target description, the defective expression, an
authored SEVERITY RANK (1 = most severe), and a rationale. Written by
the analyst, REVIEWED BY ANDREAS (severity is a product judgment, not a
model output), frozen with a content hash. Lives beside the task in
`trajectory-cost-tasks.mjs` or its own module.

**2. MATCHING (the only judged step).** For each delivered message x each
gold issue: "does this message identify this issue?" Binary, blind to
arm, multi-membership allowed — one message naming two defects credits
both (v1's clustering bug). Two judges, unanimity required, disagreements
reported not averaged.

**3. SCORING.**
  - rank-weighted recall: sum of weights of gold issues found / total,
    weight = a decreasing function of rank (report the function; start
    with linear 1/rank and also report top-k, since top-k is what
    Andreas actually described).
  - top-3 and top-5 hit rate.
  - liveness respected: an issue counts only if named while live.

**4. UNPLANTED FINDINGS — a separate axis, never folded into severity.**
Judged only for "is this a real defect evidenced by the visible code?"
Reported as: bonus finds (real, not in the gold set) and noise
(unevidenced). This is where v1's precision signal lives — MAIN raised 5
issues both judges called not-real vs F 2 and F2 1.

## What this buys

- Severity stops depending on judge reliability entirely.
- The reference set is stable across runs and arms; no pooling, no
  arm-seeding bias, no defect vanishing because nobody found it.
- REUSABLE: once a task has a gold set, every future arm scores against
  it for free. The corpus appreciates instead of ageing.
- Matches Andreas's mental model directly: "of the top issues, did the
  reviewer find them?"

## Honest limits

- The ranking is OURS. That is a feature (product-owner definition,
  stable) but it must be labelled as authored, never presented as
  objective. v1 already found both judges rating a planted defect
  "serious" where the author assumed blocking — so authored severities
  and judge intuitions genuinely differ, and the doc must say which is
  being used.
- Authoring cost is real and per-task. Mitigated by drafting from a
  strong model's reference review (severity v3 stage 1 produces exactly
  this), then editing rather than writing cold.

## Status of the running probes under this design

- severity v3 stage 1 (reference review) becomes a DRAFTING AID for the
  gold set, not a metric.
- severity v2 informs how reliable the decomposed/matching-style judgment
  is — the step this design depends on.
- Neither is wasted; both are re-purposed.
