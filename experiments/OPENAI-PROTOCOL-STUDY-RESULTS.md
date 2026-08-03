# Fresh OpenAI protocol studies — results (2026-08-02)

## Decision

**Keep the shipped ENUM-SO2 contract for the OpenAI capstone. Do not spend
capstone producer tokens on either exact simplification.**

- The terse wording shortened each finding by about 40%, but made the observer
  produce more findings, use 41% more output tokens overall, cost 34% more per
  observation, and miss more planted blocking issues.
- Removing `interrupt` increased output by 22% and cost by 18% overall. It fixed
  the control's overreaction to a dangerous command that had not started, but
  necessarily reduced both genuine in-flight emergencies to delayed `steer`
  delivery. The head still found the danger; the runtime could no longer stop
  it.
- Combining the two edits was worse: it was the most expensive arm and sent 15
  findings to `print`. Several planted defects therefore reached the user but
  not the driver.

This is a fresh causal development result, not the capstone and not a provider
split decision. A later clean study may test a clearer threshold for
`interrupt`; this study says not to delete the capability.

## Frozen run

The matrix was 9 sealed cases × 2 reasoning tiers × 2 samples × 4 arms = 144
calls. Every producer response was valid JSON; 16 calls exceeded one or both
character caps. Producer spend was $3.37301 at the registered price table.

The following table excludes the invalid quiet case from recall denominators.
Each cell therefore has 38 issue opportunities: 19 planted issues × 2 samples,
including 28 blocking opportunities. `Sol support` is one provisional judge's
central-claim decision, not two-judge precision. The support denominator still
includes findings from the invalid quiet case and is incomplete where the one
unaccepted judge batch contributed findings.

| config | arm | findings | output / call | $ / call | chars / finding | blocking recall | any-harm recall | driver-visible issues | Sol support | unjudged |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sol-high | ENUM-SO2 | 48 | 443 | $0.01700 | 263 | 27/28 | 35/38 | 35/38 | 46/47 | 1 |
| sol-high | terse | 56 | 583 | $0.02136 | 156 | 26/28 | 34/38 | 34/38 | 49/53 | 3 |
| sol-high | no-interrupt | 52 | 499 | $0.01860 | 250 | 28/28 | 36/38 | 36/38 | 50/51 | 1 |
| sol-high | terse + no-interrupt | 62 | 650 | $0.02330 | 155 | 27/28 | 35/38 | 31/38 | 56/62 | 0 |
| sol-xhigh | ENUM-SO2 | 54 | 588 | $0.02135 | 253 | 28/28 | 36/38 | 36/38 | 50/53 | 1 |
| sol-xhigh | terse | 58 | 871 | $0.02999 | 155 | 26/28 | 32/38 | 32/38 | 58/58 | 0 |
| sol-xhigh | no-interrupt | 57 | 762 | $0.02650 | 252 | 28/28 | 36/38 | 36/38 | 51/55 | 2 |
| sol-xhigh | terse + no-interrupt | 57 | 849 | $0.02928 | 154 | 28/28 | 34/38 | 31/38 | 54/57 | 0 |

The deterministic reconstruction is:

```bash
node experiments/openai-protocol-study-results.mjs \
  --rows ~/scratch/2026-08-02-openai-protocol-studies/rows.jsonl \
  --judge ~/scratch/2026-08-02-openai-protocol-studies/judge-sol.jsonl
```

## What actually changed

### Terse output moved cost in the wrong direction

Across both tiers, control produced 102 findings at 258 characters each and
516 output tokens per call. Terse produced 114 findings at 155 characters each
but required 727 output tokens per call. The model reacted to the short-sentence
instruction by enumerating more, not by doing less work. At high it also lost
one additional blocking opportunity; at xhigh it lost two.

This refutes the exact terse wording. It does not prove that concise output is
impossible; it proves that tighter caps plus this sentence is not a cost lever.

### `interrupt` carries a small but real capability

On the two active-emergency cases, control and terse emitted eight supported
issue findings and chose `interrupt` all eight times. The no-interrupt arms
found the same emergencies and chose `steer`, but `steer` cannot abort deletion
already in flight.

On the proposed-but-not-started danger, control and terse chose `interrupt` all
four times. That is too aggressive: normal driver delivery at the next
checkpoint is sufficient. Removing the word fixes those four routes only by
also removing the correct route from the eight active emergencies. The better
hypothesis is a clearer “already in flight” threshold, tested later on new
sealed cases—not deletion.

### The interaction arm broke recipient choice

The combined arm emitted 15 `print` findings, versus zero for control and
no-interrupt and one for terse. Its planted-issue discovery was 35/38 at high
and 34/38 at xhigh, but only 31/38 reached the driver in either tier. Shortness
and vocabulary removal therefore interacted with recipient selection; the
driver-visible regression is not visible in raw recall alone.

## Case and judge audit

The registered quiet case was not clean. Every arm found plausible omitted
boundaries or missing verification in the assistant's summary, including
same-key concurrency, payload binding, quantity validation, and the absence of
visible implementation evidence. It remains frozen, is marked invalid as a
quiet discriminator, and is excluded from the causal gate. No output or label
was edited after the fact.

The Sol judge made 67 batch attempts for 60 immutable batches. Fifty-nine
batches produced 436 accepted judgments. Four transport failures and four
strict-format failures are preserved in the raw log. Three of the formatting
failures came from the same eight-finding quiet-case batch: on every complete
response Sol copied one opaque 16-character key without its last character.
The validator correctly rejected all eight judgments; they remain unjudged.

This is evidence for one narrow future protocol repair: use short ordinal
candidate ids. It is not evidence to loosen validation or change the semantic
judge rules. Because the failure is confined to the already-invalid quiet
case, none of the planted-issue recall or routing comparisons depends on the
missing judgments. Charged judge spend, including rejected attempts, was
$11.39192.

Every producer response and every response-bearing judge attempt was read in
full. Supported unmatched findings remain observations from a synthetic
development study; they are not golden-dataset promotions and receive no extra
Sol vote.

## Provenance

- Case freeze: `95a8f4d`; case hash
  `44e8d60e94f8a063498478b219e87be8c68c892eb23343a634a92511e2c28c79`.
- Exact prompt/runner checkpoint: `581785b`; producer rows SHA-256
  `2c57c98a9bf48ba65e630d2c4306764abbb4f90ffb4768ca157bf7f9a1290f71`.
- Judge file SHA-256
  `b8807392f46d821a1ee4c872b7ac2dbe7b0200a207df814e297d735ca0da60f1`.
- Frozen artifacts:
  `experiments/artifacts/2026-08-02-openai-protocol-study/`.

The original rejected replies, retry notes, runtime-only concurrency change,
and ceiling extensions remain append-only in `judge-sol.jsonl.gz`.
