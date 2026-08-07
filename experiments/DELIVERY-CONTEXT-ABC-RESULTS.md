# Delivery context A/B/C: frozen results

## Verdict

Do not merge C. The bounded same-head ledger is mechanically sound, but the
current observation handoff does not meet the frozen UX gate. C improves
repeat restraint and coarse delivery choice for several models, but misses the
absolute finding-quality gate in all 12 producer configurations and exceeds
the observer-cost limit in 10 of 12.

This does not reject tool-free completion. A is already tool-free. It rejects
this larger completion envelope plus same-head context as a universal design.

## Method

The comparison uses the 41-case corpus and acceptance criteria frozen in
[`DELIVERY-CONTEXT-GOLDEN-SPEC.md`](DELIVERY-CONTEXT-GOLDEN-SPEC.md):

- **A:** shipped-main compact JSON completion at `b51c157`;
- **B:** the provider-specific completion control at `350e6f5` (typed on
  OpenAI, JSON on Anthropic); and
- **C:** tool-free footer completion plus the latest successful delivery and
  live pending queue/steer records from the observing head only.

Each of Luna, Terra, Sol, Sonnet, Opus, and Fable ran at medium and high
reasoning. Every case has two samples in every arm: 2,952 producer
observations, or 82 observations per producer/arm. Sol high and Opus high made
8,414 narrow blind TRUE/FALSE judgments for support, target, and improper
repetition. A finding passes only when both judges accept both support and
target. Provider failures remain economic observations and fail validity,
quality, and routing; a failed call that sends nothing still avoids a duplicate
send.

All three arms retained the same representative driver tools and public Hydra
schema. The comparison therefore does not attribute a difference to the tool
schema.

## A/B/C results

Percent triplets and cost triplets are A / B / C. Quality is strict two-judge
finding quality on cases requiring feedback. Bucket is the frozen
driver-invisible versus driver-aware delivery choice. Cost is measured observer
cost per observation; benchmark warm-up calls are excluded.

| Producer | Valid | Quality | Bucket | Observer cost |
|---|---:|---:|---:|---:|
| Fable high | 90.2 / 82.9 / 82.9% | 57.4 / 57.4 / 53.7% | 52.4 / 52.4 / 73.2% | $0.015266 / $0.014622 / $0.021173 |
| Fable medium | 89.0 / 78.0 / 89.0% | 66.7 / 59.3 / 61.1% | 56.1 / 51.2 / 76.8% | $0.012444 / $0.012220 / $0.015166 |
| Opus high | 97.6 / 97.6 / 97.6% | 57.4 / 63.0 / 40.7% | 62.2 / 59.8 / 82.9% | $0.007933 / $0.008228 / $0.011534 |
| Opus medium | 97.6 / 97.6 / 98.8% | 64.8 / 66.7 / 50.0% | 63.4 / 62.2 / 86.6% | $0.005961 / $0.006042 / $0.008172 |
| Sonnet high | 100 / 98.8 / 100% | 66.7 / 66.7 / 53.7% | 61.0 / 61.0 / 76.8% | $0.003117 / $0.003452 / $0.006129 |
| Sonnet medium | 100 / 97.6 / 100% | 72.2 / 64.8 / 53.7% | 61.0 / 58.5 / 67.1% | $0.002062 / $0.002544 / $0.003121 |
| Luna high | 100 / 100 / 100% | 68.5 / 77.8 / 68.5% | 64.6 / 64.6 / 72.0% | $0.002184 / $0.002942 / $0.002998 |
| Luna medium | 100 / 100 / 100% | 64.8 / 64.8 / 66.7% | 68.3 / 63.4 / 65.9% | $0.001861 / $0.002276 / $0.002409 |
| Sol high | 100 / 100 / 100% | 61.1 / 70.4 / 66.7% | 69.5 / 58.5 / 87.8% | $0.009661 / $0.012769 / $0.013106 |
| Sol medium | 100 / 100 / 100% | 61.1 / 70.4 / 75.9% | 73.2 / 63.4 / 81.7% | $0.008848 / $0.011441 / $0.011958 |
| Terra high | 100 / 100 / 100% | 66.7 / 66.7 / 70.4% | 67.1 / 63.4 / 86.6% | $0.004131 / $0.004317 / $0.004350 |
| Terra medium | 100 / 100 / 100% | 57.4 / 64.8 / 70.4% | 62.2 / 54.9 / 86.6% | $0.003871 / $0.003804 / $0.003355 |

The context-specific C metrics show why one aggregate score would be
misleading:

| Producer | Waiting restraint | Follow-up quality | Unrelated pending | Rejection A → C | Exact route C |
|---|---:|---:|---:|---:|---:|
| Fable high | 100% | 66.7% | 50.0% | 50 → 70% | 72.0% |
| Fable medium | 100% | 55.6% | 50.0% | 70 → 50% | 75.6% |
| Opus high | 96.4% | 66.7% | 16.7% | 80 → 50% | 75.6% |
| Opus medium | 100% | 66.7% | 0% | 70 → 60% | 81.7% |
| Sonnet high | 67.9% | 66.7% | 66.7% | 80 → 70% | 73.2% |
| Sonnet medium | 46.4% | 66.7% | 66.7% | 90 → 90% | 63.4% |
| Luna high | 42.9% | 77.8% | 83.3% | 100 → 90% | 62.2% |
| Luna medium | 35.7% | 88.9% | 83.3% | 100 → 90% | 54.9% |
| Sol high | 89.3% | 66.7% | 83.3% | 90 → 80% | 80.5% |
| Sol medium | 85.7% | 83.3% | 83.3% | 90 → 100% | 72.0% |
| Terra high | 89.3% | 77.8% | 100% | 90 → 90% | 78.0% |
| Terra medium | 82.1% | 77.8% | 100% | 100 → 90% | 80.5% |

## Frozen gate

| Gate | Required per configuration | Passing configurations |
|---|---:|---:|
| Successful decision | 100% | 8 / 12 |
| One provider call | ≥95% | 12 / 12 |
| Finding quality | ≥85% | 0 / 12 |
| Waiting restraint | ≥90% | 4 / 12 |
| Follow-up quality | ≥80% | 2 / 12 |
| Unrelated-pending quality | ≥85% | 2 / 12 |
| Explicit-rejection non-regression | no worse than A −10 pp | 10 / 12 |
| Improper-repeat non-regression | no worse than A −10 pp | 11 / 12 |
| Delivery bucket | ≥85% | 4 / 12 |
| Observer cost | no more than A +10% | 2 / 12 |
| Median and p95 latency | no more than A +15% / +20% | 1 / 12 |
| Cache hit | no worse than A −3 pp | 12 / 12 |

The global critical-finding gate also fails. There are 76 paired critical rows
where A passes and C fails under the conservative two-judge rule. Sixty-three
involve judge disagreement. The other 13 are enough to block release without
resolving that disagreement: four send no usable finding, four are unanimously
unsupported, and five unanimously miss the required target. Examples include
policy refusals on fresh security findings, omitting token rotation, replacing
the missing-HMAC finding with async error reporting, and returning `none` for a
still-valid token exposure.

## Economics and latency

| Producer | Cost C vs A | Median latency | p95 latency | Cache hit A → C | Zero cache reads A → C |
|---|---:|---:|---:|---:|---:|
| Fable high | +38.7% | +35.5% | +68.7% | 97.49 → 96.01% | 0 → 0 |
| Fable medium | +21.9% | +22.0% | +44.0% | 96.33 → 97.13% | 0 → 0 |
| Opus high | +45.4% | +31.5% | +41.1% | 99.90 → 99.39% | 0 → 0 |
| Opus medium | +37.1% | +17.3% | +25.3% | 99.18 → 99.39% | 0 → 0 |
| Sonnet high | +96.6% | +45.4% | +157.4% | 99.90 → 99.92% | 0 → 0 |
| Sonnet medium | +51.4% | +27.9% | +16.5% | 99.90 → 99.92% | 0 → 0 |
| Luna high | +37.3% | +25.1% | +32.8% | 0 → 0% | 82 → 82 |
| Luna medium | +29.4% | +7.2% | −1.6% | 0 → 0% | 82 → 82 |
| Sol high | +35.7% | +20.2% | +26.4% | 0 → 0% | 82 → 82 |
| Sol medium | +35.1% | +12.9% | +36.2% | 0 → 0% | 82 → 82 |
| Terra high | +5.3% | +17.5% | +39.4% | 15.03 → 53.44% | 68 → 27 |
| Terra medium | −13.3% | −4.3% | +65.4% | 17.18 → 58.28% | 66 → 22 |

The tool schema is held constant, and Anthropic cache hit stays effectively
flat. Anthropic C nevertheless costs 39.6% more in aggregate than A. Its
generated output grows from 110,549 to 171,240 tokens (+54.9%), while cached
input grows from 1,006,360 to 1,244,878 tokens (+23.7%). The longer response is
the main observed cost association; the row data does not allocate causal cost
to individual prompt clauses.

OpenAI A, B, and C cost $2.505, $3.079, and $3.130 across their 492 measured
observations per arm. B and C are therefore economically close in aggregate;
most of the increase over shipped A is not uniquely caused by adding the
ledger. Luna and Sol read zero cache in every row and pay roughly 300 more
uncached input tokens in C than A. Terra is different: C's much higher cache
read is why it is the only family that meets the cost gate.

## Qualitative audit

C is quieter, but only for some models. Fable and Opus usually wait when the
same finding is pending or newly delivered. Sonnet and Luna often send again.
Sol and Terra sit between those extremes. The right delivery choice is
similarly model-dependent; no reasoning level fixes it consistently.

The dominant quality failure is extra narrative beyond the evidence. C
messages often name likely secrets, reachability paths, stored CI artifacts,
or irreversible consequences that the trajectory does not establish. This
also explains the main judge split: among C judgments, 135 support decisions,
14 target decisions, and 23 repeat decisions disagree. In the common support
direction Opus accepts ordinary risk extrapolation while Sol requires literal
trajectory evidence. Manual review found real examples on both sides, including
an incorrect claim that a queued microtask runs before synchronous signature
verification and genuine ambiguity over whether an assistant's reported test
result counts as evidence.

The conservative rule remains useful. Under each judge alone, Opus reaches the
85% quality bar in only two configurations and Sol reaches it in none. Judge
policy ambiguity therefore changes the size of the failure, not the decision.

Anthropic also returned 83 cyber-policy errors across all arms: 21 in A, 36 in
B, and 26 in C. They are concentrated in Fable and Opus. Shipped A converts an
unparseable response to a runtime noop; the summarizer deliberately counts a
provider error as invalid and incorrectly routed even when that fallback
creates a syntactically valid noop.

## Integrity and reproducibility

Before judging, C was found to expose pending records from sibling heads in 72
rows, unlike production. The original files were copied byte-for-byte, the C
mapping was corrected to same-head-only, and only those 72 producer rows and
their judgments were replaced. Old and repaired affected rows had the same
aggregate bucket and exact-route totals. No valid observation or judgment was
discarded based on outcome.

The final artifacts are under
`/Users/spannagel/scratch/2026-07-28-hydra-abc-matrix`:

| Artifact | SHA-256 |
|---|---|
| `openai-matrix.jsonl` | `4c9cf766dce2785bf954ae065d46c2d5ee16cbd7d9b4bdfa69bf7ebbbfacb4d6` |
| `anthropic-matrix.jsonl` | `9764a911bb63951c4cd925c6e08c36880c073014c3e57cf5f50100d8a1128f1b` |
| `judgments-opus.jsonl` | `107749707a6b0fd37c7d27d2a5427ad683fc856e9b1f3d0b164e1aea95480d2c` |
| `judgments-opus-openai.jsonl` | `24de52d659f1631a509ccae1dad34b0bb921d24acc6e3c1ef518c1dc54843197` |
| `judgments-sol-openai.jsonl` | `95c741bc6abc44791216ce5c4f0ae398144a59524c056076b837a9be88b6489d` |
| `judgments-sol-anthropic.jsonl` | `07d217a1e9504b0854622eca511ff73bf554fc05b92e95c7a6141f6aa78b1b2f` |

The pre-repair archive is in `pre-samehead-repair/`. The scratch directory is
auto-pruned after 14 days. The six final files compress to about 3.3 MB, but
they are not committed because this candidate failed and a mergeable successor
will need a new frozen run.

Reproduce the summary with:

```sh
base=/Users/spannagel/scratch/2026-07-28-hydra-abc-matrix
node experiments/summarize-delivery-context-golden.mjs \
  --input "$base/openai-matrix.jsonl,$base/anthropic-matrix.jsonl" \
  --judges "$base/judgments-opus.jsonl,$base/judgments-opus-openai.jsonl,$base/judgments-sol-openai.jsonl,$base/judgments-sol-anthropic.jsonl"
```

Both judges ran through Pi in this frozen run. A future run may route Opus
through a fresh `claude -p` session for subscription billing; Sol can remain on
Pi. That operational change is not part of this comparison.

## Recommendation

Keep the bounded same-head ledger as a research checkpoint, but do not ship the
current C observation prompt or runtime path. The next hypothesis should be
narrow: retain A's compact tool-free behavior, add only factual same-head state,
and isolate prompt wording from ledger state before another full matrix. Develop
that change on the non-golden corpus, then freeze fresh validation cases rather
than tuning against these failures.
