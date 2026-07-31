# Wave 7 pre-registration — opus-5 xhigh A0/J/F screen redo (2026-07-31)

Written BEFORE producing any judged row. Motivation: the cost sweep (dd577bf)
showed F +48% vs A0 at opus-xhigh (the user's primary config), all of it
thinking tokens. Quality at xhigh is unmeasured; the medium-effort verdict
cannot be assumed to transfer.

## Design

- Config: opus-xhigh only (claude-opus-5, reasoning xhigh via pi-ai).
- Arms: A0 (main's contract), J (same JSON + unified envelope), F (footer +
  unified envelope). J at opus is a FIRST observation at any effort — no
  medium counterpart exists; J-vs-F attributions are within-xhigh only.
- Corpus: 17 cases (12 screen + 5 dev), samples 2 → 102 rows, all fresh
  (NO seeding from the sweep: rows must carry measured usage.reasoning).
- Judges: sol + opus (unchanged builders, verified vs cfe47f2), NEW scratch
  dir, unanimity across judges as in the medium screen.
- Instrument changes applied first: usageOf captures reasoning;
  --r3-informational demotes the R3 token gate to non-verdict-carrying;
  reasoningTokenMean + billedTokenMean added to group stats.

## Pre-committed rules

- X1 (channel, routing): F is REFUTED as the xhigh judge channel if its
  deliveryBucketCorrect at opus-xhigh is <= A0's. F is only CONFIRMED as
  the routing winner if it beats A0 by >= 8pp (mirror of medium R1).
- X2 (quality floor): any arm with central findingQuality more than 5pp
  below A0 at opus-xhigh is refuted (mirror of medium R2). Unanimous
  judgments only; judgedComplete must be true per cell or no verdict.
- X3 (thinking attribution): envelope-driven if (J - A0) reasoning tokens
  >= 60% of (F - A0); channel-driven if (F - J) >= 60% of (F - A0);
  otherwise mixed. This picks the NEXT lever (envelope-trim vs channel),
  it does not carry the arm verdict.
- X4 (economy): the xhigh cost verdict STANDS from the sweep (+48%
  production-priced, F vs A0). This run adds the quality side only. R3 is
  informational by flag; R1/R2 carry gates.
- X5 (does thinking buy anything): compare F@xhigh vs F@medium (same
  cases/judges/builders; medium cells from the frozen screen) on routing
  and central quality. If F@xhigh <= F@medium on BOTH, xhigh thinking
  bought nothing measurable -> recommend pinning observer effort to
  medium (runtime knob) as the primary mitigation; envelope-trim second.
- X6 (scope): single-config verdict. Never claim "replicated" — the
  medium pooled sign test has no analogue here. Say "at opus-xhigh".

## Guards (from Wave 7a scouts)

- Invariant check (node --test screen-arm-invariants.check.mjs) before
  producing; vitest + tsc green after instrument edits.
- --retry-errors; then assert exactly 102 rows, 0 errors, every
  (case,sample) present in all 3 arms, promptVariants==heads per cell.
- Judge with sol conc 4 / opus conc 2 --cli-timeout-ms 420000; check
  *.failures.jsonl after every stage; require judgedComplete per cell.
- Never append judgments to the medium screen's files (silent pooling).
- Anthropic auth valid to ~03:47 local; producer reads it at startup.
