# Opus-xhigh screen — A0 / J / F with judging (2026-07-31)

Redo of the unified-API screen at the user's primary config (claude-opus-5,
xhigh), motivated by the cost sweep (F +48% production-priced vs A0, all
thinking). Rules pre-registered before data in `XHIGH-SCREEN-SPEC.md`
(commit f6bc73b). 102 rows (17 cases x 2 samples x 3 arms), zero errors,
`usage.reasoning` measured per row; sol+opus judges, 157 judgments each,
zero failures, `judgedComplete` all cells. Artifacts:
`experiments/artifacts/2026-07-31-xhigh-screen/`. Verified independently by
a recompute agent and an adversarial refutation agent (Wave 7b); every
number below survived both.

## Verified result (n=34/arm = 26 feedback + 8 expected-none rows)

| | A0 (main) | J | F |
|---|---:|---:|---:|
| deliveryBucketCorrect | 61.8 | **82.4** | **82.4** |
| deliveryExact | 55.9 | **82.4** | 76.5 |
| feedbackBucketCorrect (warranted-feedback routing) | 76.9 | 76.9 | 80.8 |
| expected-none rows handled correctly (of 8) | **1** | 8 | 7 |
| support (centralSupported) | 96.2 | 92.3 | 92.3 |
| target | 96.2 | 84.6 | 84.6 |
| findingQuality (central AND target — the gated metric) | 96.2 | 84.6 | 84.6 |
| findingQualityStrict | 42.3 | **69.2** | 61.5 |
| improperRepeatAvoidance | 62.5 | 100 | 100 |
| harness cost/obs | $0.0119 | $0.0145 | $0.0158 |
| thinking tokens | 188 | 252 | 343 |
| answer tokens (output - reasoning) | 126 | 104 | 70 |

## Pre-registered rules, verbatim outcomes

- **X1: F CONFIRMED as routing winner** (82.4 >= 61.8 + 8).
- **X2: J and F both REFUTED on the quality floor** (84.6 < 96.2 - 5).
  Binding as registered. Decomposition (diagnosis, not re-gating): the
  entire gap is `target`; `support` alone is 96.2 vs 92.3 = one row.
  On the intersection of rows all three arms delivered, the gap is 8.3pp
  = 2 rows in 1 case (`dev-security-user-only`: expectedFinding
  revoke-token; A0 names credential rotation, both envelope arms write
  git-history scrubbing; both judges call rotation the consequential
  target; no arm routes that case's bucket correctly at any effort).
  Wording defect logged: the spec said "central findingQuality"; the gate
  compares findingQuality = central AND target.
- **X3: MIXED, rule silent** — envelope 41.5% / channel 58.5% of F's
  thinking premium (bar was 60%). No lever picked by measurement.
- **X4: stands** — +48% production-priced (sweep) is the verdict-carrying
  cost number; in-run +32.1% is the harness basis, footnote only.
- **X5: does not fire, by one row** — F@xhigh routing 82.4 > F@medium
  79.4 on bucket (would fire on exact: 76.5 < 79.4 — metric was not
  named in the spec; second wording defect). Substance: F is flat across
  efforts on every quality axis, +-1 routing row, at 2.75x cost.
- **X6: single-config scope.** Nothing here is "replicated".

## Corrected reading (what the contract actually changes at opus-xhigh)

1. **Abstention, not routing skill.** On warranted-feedback rows the
   contract does nothing (76.9/76.9/80.8; opposite sign at medium). The
   whole 20.6pp bucket gap is expected-none behavior: A0 speaks on 7/8
   quiet rows — 5 steer + 2 queue, zero print, i.e. genuine interrupts —
   J 0/8, F 1/8 wrong. Replicated at medium (A0 6/8 sends).
2. **Side-claims.** A0's messages carry unsupported extras at 2-3x J's
   rate (both judges agree on direction independently), and A0's unjudged
   `reason` field makes that measurement generous to A0.
3. NOT supported: "the contract steers where thinking goes" (X3 mixed;
   F's worst message burned 5.4x its mean thinking), and "J dominates F"
   (case-level 1-1 tie; J's real edges are -26% thinking and zero
   over-delivery; J has no opus-medium cell).
4. **A0 itself degrades at xhigh**: bucket 67.6 -> 61.8, exact 64.7 ->
   55.9, improper sends 6 -> 7, at 2.22x the cost of A0@medium. For
   main's shipped contract, xhigh thinking buys worse routing at double
   the price.

## Options at opus-xhigh, ranked by the user's hierarchy

Quality cannot rank the options (every difference <= 3 rows; both
envelope arms refuted on the floor, A0 refuted by nothing but carries
1/8 expected-none handling and 42.3 strict). Economics ranks decisively:
effort moves cost 122-175%, contract moves it <= 32%.

**(e) pin observer effort to medium + F** > **(a-medium) A0 pinned to
medium** > **(c) F everywhere** > **(a) A0 as shipped** > **(b) J at
high-effort branches** > **(d) J everywhere**.

**RETRACTED 2026-08-01 (Andreas):** options (e) and (a-medium) are
infeasible — observer and driver MUST share the thinking level or the
observer's replay of the driver's prefix stops hitting the prompt cache,
and losing the cached driver transcript costs far more than any thinking
savings. Observer effort is coupled to driver effort by design. The
ranking collapses to (c) > (a) > (b) > (d); the remaining cost levers at
xhigh are envelope-trim (targets input + the one-case quality defect,
but only ~41% of the thinking premium) and channel thinking (J −26% vs
F at xhigh; thin evidence, case-level tie).

(e) sacrifices one measured routing row on one case vs F@xhigh and saves
2.75x; the envelope prompt tax is effort-invariant (+220 tokens both
efforts) — only the price tier moves. (b)/(d) are disfavored on evidence
width (J exists in 3 cells ever) and X6. Statistical bound on all of it:
best case-level sign test p=0.0625 (floor at n=17); the gates fired on
rates as registered, the p-values bound the confidence.

## Opus-high replication (same day, pre-registered addendum)

102 rows, same instrument/corpus/judges, zero errors/failures,
judgedComplete all cells. Artifacts:
`experiments/artifacts/2026-07-31-high-screen/`.

| | A0 | J | F |
|---|---:|---:|---:|
| deliveryBucketCorrect | 70.6 | **82.4** | **82.4** |
| deliveryExact | 64.7 | **82.4** | **82.4** |
| support | 92.3 | 92.3 | 88.5 |
| target | 92.3 | 84.6 | 84.6 |
| findingQuality (gated) | 92.3 | 84.6 | 84.6 |
| findingQualityStrict | 73.1 | 57.7 | 46.2 |
| improperRepeatAvoidance | 50.0 | 100 | 100 |
| harness cost/obs | $0.0094 | $0.0128 | $0.0124 |
| thinking tokens | 87 | 192 | 213 |

- **H1: J and F both CONFIRMED on routing** (+11.8pp >= +8).
- **H2: J and F both REFUTED on the floor** (84.6 < 92.3 - 5) — and the
  breach is carried ENTIRELY by `target` on `dev-security-user-only`,
  both samples, unanimous, exactly as at xhigh. Per the pre-registered
  addendum this is a REPLICATION of the single xhigh finding, not an
  independent refutation. A0: zero target misses at either effort;
  envelope arms: 8/8 rows miss on this one case across both efforts
  (they recommend git-history scrubbing where the consequential fix is
  credential revocation). `support` is at parity (J = A0 exactly).
- Strict is unstable across efforts (A0 42.3 at xhigh vs 73.1 at high;
  F 61.5 vs 46.2) — judge-split-sensitive at this n; do not lean on it.
- Abstention replicates: A0 restraint 50 vs envelope 100 at every
  effort measured. Cost: F +15% production-priced at high (sweep basis),
  in-run F cheaper than J here (J-cheaper was xhigh-specific).

**Net across both primary configs:** the entire measured quality
objection to the unified envelope is one behavioral quirk on one case
type — remediation-priority steering on an exposed-credential review.
Everything else (routing, abstention, support, validity) replicates in
the envelope arms' favor. That quirk is a targeted envelope-wording fix
(e.g. a consequential-remediation clause), testable on this exact case
before any wider rerun.

## Undetermined / next

1. opus-high (second primary config): ZERO judged rows at any arm —
   replication run pre-registered in the spec addendum, running next.
   It also independently retests the one case carrying X2.
2. Whether X2 is real or 3-row noise (resample xhigh at samples 8 if
   opus-high comes back ambiguous).
3. J at opus-medium (closes option d; disfavored already).
4. fable: 12 deterministic policy refusals on security cases + 2x opus
   price — unsuitable as security-lens observer regardless of contract;
   probe refusals across the full corpus before any fable quality spend.
5. Envelope-trim targets the quality loss (100% envelope-attributable)
   but not most of the cost (58.5% channel).
