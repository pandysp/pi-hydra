# Universal tool-free completion A/B

Date: 2026-07-25

## Question

Can every head return its final delivery as validated text, leaving the
`hydra` tool responsible only for head-set mutations, without losing the
reliability and review quality of OpenAI's typed completion?

## Candidate contract

The final assistant turn contains exactly one JSON object and no other text:

```json
{"delivery":"none|print|queue|steer|interrupt","message":"…"}
```

`message` is exactly empty for `none` and non-empty for every routed delivery.
The runtime accepts only those two keys, validates the delivery and message,
and fails closed on malformed output. It does not extract JSON from prose or
repair an invalid response.

The public `hydra` tool keeps the approved management interface:

```json
{
  "action": "manage_heads",
  "operation": "add|remove",
  "head": "quality",
  "message": "Why this change fits the trajectory"
}
```

OpenAI keeps the separate user lens followed by a developer protocol
envelope. Anthropic keeps one combined user message. Successful self-removal
remains programmatically terminal; every other acting observation ends with
the JSON decision.

## Frozen comparison

- **Current:** the production provider split: typed completion on OpenAI,
  three-field compact JSON on Anthropic.
- **Tool-free:** the two-field JSON decision plus management-only tool schema.
- **OpenAI cleanup control:** typed completion with delivery meanings stated
  once, separating the already-approved envelope cleanup from completion
  transport.

The same saved trajectories, head definitions, acting cases, model settings,
and runtime delivery validators are used in paired randomized order. Each
measured call gets its own identical warm request.

## Definition of Done

Report, by provider, model, and thinking level:

- strict completion validity and recovery turns;
- expected review action plus blinded message quality;
- acting-case correctness, including write/edit delivery, head addition, and
  terminal self-removal;
- driver reply and head-management correctness with the smaller schema;
- provider calls, latency, input/output/reasoning tokens, cache reads,
  zero-cache calls, and cost.

The tool-free design is viable only if it has no material qualitative
regression and does not replace normal-case savings with recovery turns.
Malformed output, incorrect delivery, and missed work remain failures; no
scenario-specific prompt exception, parser repair, artificial delay, or cache
padding is allowed.

## Scope

Screen OpenAI Luna, Terra, and Sol and Anthropic Sonnet and Opus at low and
medium. Do not use Fable, high, or xhigh unless a specific failure requires a
targeted probe. Expand samples only after the cheap screen remains plausible.

## Results

### OpenAI review heads

The final paired confirmation covered 72 observations: Luna, Terra, and Sol at
low and medium; three saved checkpoints; security and quality; two samples per
cell.

| Metric | Typed completion | Tool-free JSON |
|---|---:|---:|
| Strictly valid | 72/72 | 72/72 |
| Expected action | 21/72 | 19/72 |
| Mean latency | 5.93 s | 5.59 s |
| p95 latency | 12.89 s | 10.25 s |
| Cost | $0.5323 | $0.4886 |
| Token-weighted cache hit | 57.4% | 58.4% |
| Zero-cache calls | 20/72 | 21/72 |

The transport comparison alone therefore favored tool-free JSON: 8.2% lower
cost, 5.7% lower mean latency, and 20.5% lower p95 latency. It did not improve
cache behavior.

The blinded message-quality gate did not pass. Opus 4.8 medium and Terra
medium independently judged every paired result after both wrappers were
normalized to the same delivery and message representation. Across 144
judgments, typed completion won 36, tool-free JSON won 15, and 93 tied. Exact
winner agreement was 51/72 pairs (70.8%). The largest difference was on Terra:
typed completion won 16 judgments, tool-free won 4, and 28 tied. Inspection of
unanimous cases found substantive review differences, not wrapper preferences:
the JSON arm more often printed or nooped a finding that warranted steering.

### OpenAI acting heads

The paired acting matrix covered docs writes, tuner edits, head addition, and
self-removal across the same six model/effort cells.

| Metric | Typed completion | Tool-free JSON |
|---|---:|---:|
| Correct cases | 24/24 | 24/24 |
| Provider calls | 73 | 80 |
| Mean latency | 8.99 s | 9.13 s |
| Cost | $0.3244 | $0.3276 |
| Token-weighted cache hit | 24.1% | 14.4% |
| Zero-cache calls | 13/24 | 19/24 |
| Self-removal | 6/6 at 1.00 calls | 6/6 at 1.00 calls |

Both protocols behaved correctly, but tool-free completion required seven more
provider calls outside self-removal and erased the review-head cost advantage.

### Driver schema

Removing completion from the public tool schema reduced the tool serialization
from 2,185 to 1,556 bytes. Across Luna, Terra, and Sol at low and medium, it
saved exactly 135 fresh input tokens in every one of 12 matched warm pairs.
All 12 management-only warm requests replied or added a head correctly. The
current schema also passed all 12 warm requests; one separate Luna medium prime
copied the historical `action: "add"` shape before the management-only
description was clarified.

### Anthropic screen

Sonnet and Opus at low and medium produced valid compact JSON in all 24 review
pairs and correct behavior in all 16 acting pairs. The two-field candidate did
not establish a quality advantage over the current compact JSON protocol:
expected review actions were 6/24 versus 7/24. In acting cases it saved two
provider calls and about $0.030, but this small screen used the earlier,
weaker delivery wording and was not expanded after the universal proposal
failed the OpenAI quality gate.

### Robustness

One Luna low screen returned prose instead of JSON. Five targeted replications
and all 72 final OpenAI review observations were strictly valid. The parser
remained fail-closed: no prose extraction, repair, retry, or scenario-specific
exception was added.

## Decision

Do not replace OpenAI typed completion with a universal tool-free contract.
The savings are real for judging heads, but they buy a measurable qualitative
regression and disappear for acting heads. Keep the provider split:

- OpenAI uses typed `complete_observation`.
- Anthropic uses the measured compact-JSON fallback.
- The shared public schema remains unchanged.

Apply only the independent OpenAI judge-envelope cleanup: state lens authority,
completion cardinality, delivery routing, message constraints, and tool denial
once. Its earlier causal A/B saved exactly 126 fresh tokens while preserving
all positive findings in 36/36 low-and-medium requests. This is a prompt
deduplication, not a protocol or API change.

## Follow-up causal isolation

The first comparison changed both completion transport and the public tool
schema. A focused Terra follow-up separated four factors:

1. typed completion with the full schema;
2. JSON completion with that identical full schema;
3. JSON completion with the management-only schema;
4. the management-only arm with an explicit explanation that visible tools
   belong to the cached driver prefix and are unavailable to the observer.

The full-schema JSON arm was first run for three samples per low/medium cell,
then independently replicated for samples four through six. Its envelope was
the original concise JSON envelope, without the cache-prefix explanation.

| Terra low + medium | Typed, full schema | JSON, same full schema |
|---|---:|---:|
| Strictly valid | 72/72 | 72/72 |
| Expected action | 36/72 | 23/72 |
| Paired outcomes | 22 both, 14 typed-only | 1 JSON-only, 35 neither |
| Provider calls | 72 | 72 |
| Mean latency | 4.56 s | 4.17 s |
| Mean output tokens | 161.6 | 142.3 |
| Cost | $0.2949 | $0.2815 |

The direction replicated: samples one through three produced six typed-only
and zero JSON-only wins; samples four through six produced eight typed-only
and one JSON-only win. Low and medium each scored 18/36 for typed completion,
versus 12/36 and 11/36 for JSON.

The differences were concentrated in two meaningful behaviors:

- detecting the visible quality defect: 5/12 typed versus 0/12 JSON;
- suppressing already-delivered security feedback: 7/12 versus 1/12.

Both arms still shared major fixture failures, including repeating security at
the security-reported checkpoint and repeating quality at the both-reported
checkpoint. The result therefore identifies a relative transport effect; it
does not establish high absolute review quality.

### Rejected explanations

- **Schema as prompt:** holding the complete tool description and parameters
  identical did not remove the difference.
- **Unexplained cached tools:** explicitly explaining their presence prevented
  tool excursions but scored 9/36, versus 10/36 for the original
  management-only wording and 18/36 typed. The wording was not a quality fix.
  One original management-only observation called the unavailable tool
  repeatedly and required nine provider turns, so the operational ambiguity is
  nevertheless real.
- **A fixed semantic discriminator:** JSON with
  `"action":"complete_observation"` was reliable only while the full schema
  reinforced that value. With the management-only schema, 12/36 responses
  instead used the delivery as the action and failed strict validation.
- **Using action as the delivery:** the strict two-field
  `{"action":"noop|print|queue|steer|interrupt","message":"..."}` form was
  valid in 36/36 fresh cases but scored 6/36 versus 17/36 typed.

### Interpretation

On Terra, native tool completion changes generation behavior beyond enforcing
syntax. With the schema held fixed, it produced about 14% more output and took
about 9% longer, while improving both defect detection and restraint. Even
among pairs choosing the same delivery, typed completion generated 147 versus
133 output tokens on average. The extra work is therefore not only a
consequence of choosing more non-noop actions, although the provider does not
expose enough detail to prove whether it is hidden reasoning, structured-call
overhead, or both.

This is evidence against a quality-neutral OpenAI migration. It remains a
product tradeoff: a universal tool-free path removes permanent provider
branching, but on this real trajectory it knowingly gives up measured Terra
review quality. The result is limited to one trajectory, two generic heads,
and Terra low/medium; it should not be generalized to every future model.

## Superseding targeted parity result (2026-07-26)

The preceding decision was correct for the strict JSON candidates tested at
that point. It is superseded for the two target judging-head behaviors by a
different tool-free protocol. The new candidate does not serialize the finding
inside JSON. It returns either:

```text
DELIVERY: none
```

or one natural-language finding followed by one strict footer:

```text
<finding>
DELIVERY: print|queue|steer|interrupt
```

The handoff also contains explicit, current-task feedback state for that head.
The records are quoted as data. Semantically equivalent feedback counts as
already delivered even while the underlying issue remains unresolved; a
materially different finding remains eligible. This is the mechanism that
fixed duplicate suppression. Merely teaching the model how bracket-tagged
messages appear in the trajectory did not.

For current work, a fresh finding uses `steer` when leaving it unresolved would
leave the work incorrect, unsafe, incomplete, or unverified. `queue` remains
for genuinely deferrable follow-up. This generic rule fixed the recurring
`print`/`queue` misclassification without redefining any lens.

The parser is strict and fail-closed. A malformed completion gets one format-
only recovery turn, provided the observation has not already used its two-call
budget. The correction says to preserve the semantic decision and finding; it
does not re-run or steer the review. Normal observations remain one call.

### OpenAI confirmation

The final frozen OpenAI run covered Luna, Terra, and Sol at low and medium,
with four fresh samples per model/thinking/target cell. The comparison was the
deduplicated typed completion envelope versus the unified tool-free candidate.

| 48 observations per arm | Typed completion | Tool-free candidate |
|---|---:|---:|
| Strictly valid | 48/48 | 48/48 |
| Expected quality `steer` | 2/24 | 7/24 |
| Exact swallowed-failure finding | 1/24 | 3/24 |
| Semantic duplicate suppression | 0/24 | 23/24 |
| Provider calls | 48 | 48 |
| Mean latency | 5.75 s | 5.94 s |
| Output tokens | 8,381 | 7,716 |
| Cost | $0.3018 | $0.3076 |

The one candidate security non-noop that was not a duplicate found a distinct,
concrete unbounded-buffering denial of service. One other candidate repeated
the already-delivered HMAC finding. Thus action-level noop accuracy was 22/24,
while semantic duplicate suppression was 23/24.

A frozen, blinded Sol/high judge preferred the tool-free candidate 31 times,
typed completion five times, and tied 12. The judge rubric normalized both
wrappers before scoring.

### Anthropic confirmation

The final paired Anthropic run covered Sonnet 5 and Opus 4.8 at low and medium,
again with four samples per model/thinking/target cell. It compared the current
compact-JSON protocol with the same unified tool-free semantics in Anthropic's
combined-user handoff.

| 32 observations per arm | Current compact JSON | Tool-free candidate |
|---|---:|---:|
| Strictly valid after bounded recovery | 32/32 | 32/32 |
| Exact expected action | 0/32 | 23/32 |
| Exact swallowed-failure finding | 5/16 | 8/16 |
| Exact duplicate suppression | 0/16 | 15/16 |
| Provider calls | 32 | 33 |
| Mean latency | 3.99 s | 3.11 s |
| p95 latency | 10.04 s | 7.16 s |
| Output tokens | 4,961 | 2,726 |
| Cost | $0.1456 | $0.1026 |

Sonnet improved from 5/8 to 8/8 at detecting the quality defect and from 0/8
to 8/8 at routing it as the required `steer`. Opus remained 0/8 in both arms:
this is parity, not an invented win. On suppression, the candidate scored
15/16 versus 0/16. One of 32 candidate observations needed its single format-
recovery call; no semantic retry occurred.

After correcting the judge rubric to recognize Anthropic's existing
three-field JSON wrapper as valid, the frozen Sol/high judge preferred the
candidate 23 times, current zero times, and tied nine. All eight Opus quality
pairs tied; the candidate's wins came from real Sonnet detection and duplicate
suppression, not wrapper preference.

### Invalid evidence excluded

Two intermediate results are deliberately excluded:

- An Anthropic finding-only arm accidentally received the generic JSON prompt,
  whose noop object was then interpreted as a natural finding. Its apparent
  8/8 was a harness false positive. The corrected arm scored 1/8 on Opus.
- The first Anthropic blind judge omitted the current JSON wrapper from its
  valid-format list and returned an artificial 32-0 preference. The corrected
  rubric produced the 23-0-9 result above.

### Decision and boundary

For the two named judging-head behaviors, the unified tool-free candidate has
cleared parity: it is better on both providers, has no model-family regression,
and its only observed format failures recover within a strict two-call bound.
This supersedes the earlier OpenAI rejection for these behaviors.

The result does not prove every acting head, every delivery pattern, or every
future lens. It also proves only per-head feedback history. Supplying the full
cross-head queued/steered pipeline is a promising generalization, but same-wave
parallel heads cannot see decisions that do not yet exist; that broader ledger
needs its own test rather than being claimed here.

## Bounded delivery-context experiment (2026-07-26–27)

The ledger representation survived testing, but its original semantics did
not. For each observation it contains exactly:

- this head's last successful delivery, or `null`; and
- every queue or steer message that is still pending, across all heads.

Completed history older than the last same-head delivery is absent. Failed or
consumed messages and pending print/interrupt deliveries are also absent.
Deterministic tests cover selection, cross-head provenance, and bounded size
after 100 completed deliveries.

The rejected experiment treated this bounded ledger as authoritative dedup
memory. That premise was wrong. A fork already sees the driver's conversation,
including older delivered feedback and what happened afterward. The bounded
ledger exists only to bridge races: a successful delivery may be newer than the
fork snapshot, and pending feedback has not reached the driver yet. It must add
facts, not erase the fork's history or decide whether a follow-up is warranted.

The corrected experiment compared four prompt semantics on one real immutable
session with synthetic driver reactions:

1. enforced suppression of related `lastByThisHead` and `pending` records;
2. factual state with no repetition guidance;
3. non-binding judgment guidance; and
4. evidence-guided factual state, which asks the head to look for actual
   rejection or material change and says unrelated pending feedback remains
   eligible.

Luna, Terra, and Sol ran at low thinking. A broad one-sample screen covered 11
contexts per model. A focused two-sample replication covered the seven cases
that distinguish the designs: just delivered, visible but unanswered,
explicitly ignored, equivalent pending, and unrelated pending. Blinded Sol
judges scored factual correctness, context, usefulness, restraint, and routing.
The first screen used high thinking; the larger replication used medium.

The semantic tradeoff is real:

- Enforced suppression was more conservative overall. In the focused
  replication it scored 26 passes and 12 failures, versus 20 passes and 22
  failures for the first judgment-guided wording.
- It achieved that precision by making contextual recovery impossible. Across
  the 12 explicitly ignored security and quality cases, the guided arm
  re-raised the rejected target 12/12 times. The enforced arm did so 0/12; it
  either stayed silent or diverted to another finding.
- Evidence-guided wording was the strongest autonomy-preserving version: in a
  direct comparison it scored 24 passes and 11 failures versus 20 and 16 for
  the earlier guided wording. It still did not beat enforced suppression
  universally.
- Model behavior differed. Against enforced suppression, evidence guidance was
  materially better on Terra (mean 16.93 versus 13.43 out of 20; one failure
  versus four), but worse on Luna and Sol. One of its 42 completions remained
  malformed after bounded recovery.

Runtime did not expose a new UX cost. In the focused replication the first
guided arm averaged 4.67 seconds and $0.0054 per observation, versus 6.29
seconds and $0.0073 for enforced suppression. The guided responses were much
shorter; cache-read volatility also differed, so these numbers show absence of
a measured penalty, not a causal speedup from the wording.

### Decision and runtime boundary

Reject automatic suppression as the product semantic. It cannot distinguish
"already handled" from "delivered but explicitly rejected," and that false
negative is exactly what a continuing observer should be able to correct.

Use the bounded ledger as factual timing context. The best tested generic
guidance is evidence-based and non-binding: compare only related feedback,
look for visible rejection or material change, do not treat a merely unresolved
defect as proof it was ignored, prefer waiting while feedback is pending or
newly delivered, and leave the final decision to the lens. This adds no
head-specific or model-specific branch.

This is an OpenAI result. Anthropic confirmation was blocked by an expired
local login and must happen before claiming cross-provider generality.

Production wiring still needs an owned delivery ledger. Pi exposes only a
boolean pending-message check to extensions, not the queue contents or its
`queue_update` event. Hydra can track messages it sends and mark them consumed
when their exact user/custom `message_start` arrives; `agent_settled` can clear
any orphaned records. Same-wave parallel heads still cannot see one another's
decisions before those decisions exist.
