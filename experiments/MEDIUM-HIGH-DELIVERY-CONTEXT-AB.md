# Medium/high delivery-context A/B: frozen run plan

## Question

Can the simple, head-decided delivery context meet the existing quality bar at
medium or high reasoning without adding structured classification, runtime
semantic suppression, or another provider call?

No prompt, head, corpus, parser, or delivery behavior changes after this plan
is frozen. Runs are resumable. Failed provider calls may be retried; valid rows
are never replaced.

### Pre-judging harness amendment

The first producer run exposed a production-parity error before any row was
judged: the low-effort research runner still set `maxTokens: 700`, while the
production judge path sets no output ceiling. Anthropic medium/high responses
stopped exactly at that artificial limit (13 control rows and one final row
were structurally invalid). A cap can also constrain valid reasoning, so the
entire first producer run was invalidated rather than selectively retrying
failures. Its raw rows are preserved with a `capped700` suffix.

The only amendment removes that option so every provider uses the model's
normal production capacity. Corpus, prompts, arms, samples, randomization,
judging, and acceptance criteria are unchanged. No capped row enters the final
analysis.

## Final A/B

Run the unchanged 36-case golden corpus with two samples for every pair:

- producers: `terra-medium`, `terra-high`, `sonnet-medium`, `sonnet-high`;
- control: the production behavior at `350e6f5`;
- final design: tool-free judge completion plus the latest successful
  same-head delivery and still-pending same-head queue/steer deliveries; and
- randomized arm order within each model/case/sample pair.

This is 576 measured observations. Each measured call retains the existing
representative driver tools and receives its normal warm request so latency,
cache, and cost remain comparable with the frozen low-effort baseline.

## Targeted causal ablations

Every ablation reuses the matching final-A/B rows and runs only the missing
arm. Each has two samples at all four producer configurations.

### Completion channel: `base`

Tool-free completion without delivery context, on the five critical cases that
have no delivery state:

- `webhook-security-fresh`
- `login-security-fresh`
- `login-security-user-only-rotation`
- `diagnostics-security-fresh`
- `diagnostics-security-live-exfiltration`

This isolates the tool-free handoff from the bounded ledger. Forty measured
observations.

### Sibling context: `treatment`

The earlier across-head pending context, on all three critical
`pending-unrelated` cases:

- `webhook-security-pending-unrelated`
- `login-security-pending-unrelated`
- `diagnostics-security-pending-unrelated`

Compare with the final same-head rows. Twenty-four measured observations.

### Successful-context retention: `unseenonly`

Show the latest success only when the static case represents a delivery newer
than the captured fork, on the 18 last-bearing cases in these categories:

- newly delivered/no response;
- visible/no response;
- explicit or older visible rejection;
- full resolution; and
- material change.

Compare with the final same-head rows. This tests whether the latest success is
only a transport-race bridge or also a useful salience pointer. One hundred
forty-four measured observations.

## Evaluation

Apply the acceptance criteria frozen in `DELIVERY-CONTEXT-GOLDEN-SPEC.md`
separately to every producer configuration. Also report paired changes from
the corresponding control and the frozen low-effort baseline.

Blind-judge every valid row with Sol at high reasoning. Model, effort, and arm
remain hidden from the judge. Report:

- structural validity, one-call completion, and recovery;
- supported required findings, waiting, follow-up, unrelated pending, and
  critical recall;
- exact and blind delivery routing, false and genuine interrupts;
- mean blind score, failure rate, and treatment-only critical misses;
- median and p95 observer latency;
- observer cost, cache-hit ratio, and zero-cache reads; and
- paired wins, losses, and ties.

The experiment does not tune prompts or select a winner from isolated point
estimates. Any critical treatment-only miss is inspected case by case. Rejected
arms remain experimental even if one aggregate improves.

## Results

The uncapped run produced all 784 planned observations. Sol at high reasoning
blind-judged all 780 structurally valid completions. The final `samehead` arm
was structurally valid in every row; three Sonnet-high control rows and one
Sonnet-medium `unseenonly` row were invalid and remain failures.

### Final design

| Producer | Semantic | Required feedback | Critical | Waiting | Follow-up | Unrelated pending | Exact delivery | Score | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Terra medium | 70.8% | 70.5% | 73.3% | 71.4% | 77.8% | 100.0% | 76.4% | 16.72/20 | 22.2% |
| Terra high | 69.4% | 70.5% | 76.7% | 67.9% | 77.8% | 100.0% | 73.6% | 16.49/20 | 19.4% |
| Sonnet medium | 54.2% | 68.2% | 70.0% | 32.1% | 66.7% | 83.3% | 62.5% | 14.81/20 | 34.7% |
| Sonnet high | 68.1% | 75.0% | 83.3% | 57.1% | 83.3% | 83.3% | 72.2% | 16.18/20 | 22.2% |

Every final arm finished at least 97.2% of observations in one provider call.
Terra had no false interrupts, but interrupted only one of four genuine
medium-effort emergencies and neither high-effort emergency. Sonnet high routed
both genuine emergencies correctly; Sonnet medium also did, but over-escalated
three rejected findings to `interrupt`.

Against control, the final arm won the blind score comparison 112 times, lost
59, and tied 114. Mean score increased by 1.45 to 3.68 points and failure rate
fell by 8.4 to 22.2 percentage points in every producer configuration. The
relative gain is real, but no configuration meets the frozen absolute gates for
required findings, waiting, or exact delivery.

| Producer | Median latency | p95 latency | Observer cost | Cache-hit change |
|---|---:|---:|---:|---:|
| Terra medium | -5.0% | +56.2% | +0.5% | +24.52 pp |
| Terra high | -1.7% | -1.0% | -1.1% | +21.27 pp |
| Sonnet medium | +10.5% | +13.7% | +36.4% | -0.28 pp |
| Sonnet high | +74.8% | +71.1% | +82.7% | -0.50 pp |

OpenAI cache reads remained unstable: control had 64 and 66 zero-read rows at
medium and high, versus 41 and 46 in `samehead`. Sonnet's cost increase was
primarily generated output, not another provider round trip: mean output grew
from 200 to 273 tokens at medium and from 341 to 636 at high; only one and two
rows respectively used format recovery.

### Causal ablations

- On the 40 empty-state completion cases, `samehead` had three unique semantic
  successes versus two for `base`, with 25 both-correct and ten both-wrong.
  Every configuration's mean score was higher with the final envelope.
- On the 24 unrelated-pending pairs, same-head-only context had three unique
  semantic successes and across-head `treatment` had none; 19 were both-correct
  and two both-wrong. Sibling pending state provides no measured benefit.
- On the 143 judged successful-context pairs, retaining the latest successful
  delivery produced 29 unique semantic successes versus 17 for `unseenonly`,
  with 70 both-correct and 27 both-wrong. It especially improves waiting and
  fixed cases.
- That last aggregate hides the important counter-tradeoff: omitting the latest
  successful record won all four Terra samples of
  `webhook-security-material-change`. The retained record repeatedly anchored
  Terra on the old finding, causing it to omit or understate the newly expanded
  impact. Sonnet also had isolated routing improvements after rejection when
  the record was absent.

The architecture is therefore better than control and each simpler ablation,
but it is not mergeable under the declared gate. Higher thinking does not cure
the remaining finding and routing failures, so a blanket "not recommended below
medium" limitation is not supported by this run. The earlier one-sample low
screen is only directional, but agrees: overall semantic correctness was 69.4%
for Terra low versus 70.8% medium and 69.4% high; Sonnet was 55.6% low, 54.2%
medium, and 68.1% high.

## Frozen inputs

| Input | SHA-256 |
|---|---|
| `delivery-context-golden-cases.mjs` | `6833061ae0f6e15709f4387120d23c5d597e157c40b55cfc8039d2eb57567275` |
| `utils.ts` | `4a3235c15b88aae83a23a680daf3d3a1710d728c8de00039d6ec69412fd98c67` |
| `protocol.ts` | `ba63e4c7b2c591c0bc6db7a3af21045170a3ad148147deeebd6e280775fabc0b` |
| `delivery.ts` | `4a2e1b6f64b6cd8c5483c50fb68f82ee2560890d68ec2340bfae8be63036b879` |
| `delivery-context-golden-ab.mjs` before parity amendment | `6b96224f11b930ddc4e56690bd852ebb72d9191d2650d64abd3fa6893c26dc6c` |
| `delivery-context-golden-ab.mjs` final | `303c566513a562739917c68fa8b7190fcd629177ea4f44b0190d598fdbb5b9ba` |
