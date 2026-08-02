# Completion cost and latency causal ablation

> **SUPERSEDED IN PART.** This doc's recommendation to keep the FULL shared
> public schema was reversed by the acting-channel smoke
> ([`ACTING-CHANNEL-SMOKE-RESULTS.md`](ACTING-CHANNEL-SMOKE-RESULTS.md)):
> self-removal terminality measured channel-independent and tool-free acting
> measured cheaper, so the unified API ships a management-only schema. The
> causal cost findings here stand.

Date: 2026-07-24

## Question

Why did enforceable `complete_observation` completion cost about 17% more in
the pooled OpenAI review benchmark, and why was native Anthropic completion
roughly twice as slow and expensive?

The answer is provider-specific. There is no single tool-call tax.

## Method

`completion-causal-ablation.mjs` separates:

- legacy versus current versus completion-only public schemas;
- legacy versus current versus deduplicated observation envelopes;
- compact JSON versus native tool completion;
- deterministic decisions versus natural security and quality reviews.

Every arm receives the same captured trajectory and nuisance bytes. A request
primes its own provider session, followed by byte-identical warm requests.
Calls are sequential for latency. Token and cost comparisons use matched cache
strata; unmatched cache reads are reported separately instead of being
mistaken for a schema or protocol effect.

`main-agent-schema-ablation.mjs` repeats the schema comparison from the
driver's side and checks both a no-tool reply and a real `manage_heads` call.

The installed CLI and local benchmark dependencies were then aligned on pi
0.82.0. That upgrade required passing pi-ai's `streamSimple` explicitly to the
new `runAgentLoop` signature. A cheap invariant rerun found byte-identical
OpenAI tool, message, and system payloads; the schema deltas and deterministic
outputs below were unchanged. Pi 0.82 also corrects GPT-5.6's advertised
context window from 372K to 272K. The prices used below 272K did not change.

## The pooled OpenAI result hid three different model results

The original 48-observation-per-model review matrix was:

| Model | Cost change | Latency change |
|---|---:|---:|
| Luna | -18.8% | -26.2% |
| Terra | +2.4% | -1.2% |
| Sol | +34.0% | +29.3% |

The pooled +16.7% cost increase is therefore a Sol regression, not a general
OpenAI tool-completion regression. Luna improved because typed completion
removed retry turns.

## Anthropic: native completion changes generation behavior

With a deterministic decision and the same minimal schema, Sonnet low produced
36 output tokens as JSON and 100 as a tool call, with no reasoning in either
arm:

| Transport | Mean latency | Output | Mean cost |
|---|---:|---:|---:|
| JSON | 1.42 s | 36 | $0.001454 |
| Tool | 1.77 s | 100 | $0.002086 |

That is a fixed structured-completion premium, independent of the large Hydra
schema.

On natural reviews, native completion additionally caused Sonnet to reason
more even when the selected delivery action matched:

| Model / effort | JSON latency / cost | Tool latency / cost | JSON output / reasoning | Tool output / reasoning |
|---|---:|---:|---:|---:|
| Sonnet low | 2.46 s / $0.00182 | 3.90 s / $0.00296 | 102 / 0 | 217 / 66 |
| Sonnet medium | 2.27 s / $0.00180 | 4.19 s / $0.00340 | 95 / 0 | 256 / 108 |
| Opus low | 6.30 s / $0.00866 | 6.79 s / $0.00969 | 257 / 176 | 299 / 195 |
| Opus medium | 8.49 s / $0.01380 | 7.95 s / $0.01397 | 457 / 395 | 465 / 354 |

The large penalty is real for Sonnet, smaller for Opus low, and effectively
neutral for Opus medium. It is not an extra provider round trip: every matched
row above used one provider call.

The full shared schema added 527 cached Anthropic tokens over the minimal tool
schema but left deterministic output unchanged. Cached schemas are billed at
the cache-read rate; they are not free, but they are not the main Anthropic
regression.

Conclusion: keep Anthropic's compact-JSON completion fallback. Real work and
head management can remain tools.

## OpenAI: the tool transport is not the cost regression

With the same minimal schema and matched cache state:

- Luna tool completion was cost-neutral and slightly faster.
- Terra tool completion was materially cheaper and faster because the JSON
  arm reasoned more.
- Sol low paid only the fixed structured-call premium: about eight output
  tokens and roughly 3% cost.
- Sol medium natural reviews were effectively equal: 133.5 JSON output tokens
  versus 133.75 tool tokens in matched-cache pairs, with tool mode about 5%
  slower.

The stable OpenAI input deltas are:

| Change | Fresh input delta |
|---|---:|
| Legacy schema to current schema | +214 tokens |
| Legacy envelope to current envelope, net of transport | +122 tokens |
| Legacy schema + envelope to current schema + envelope | +336 tokens |
| Minimal completion schema to full current schema | +342 tokens |
| Current JSON instruction to current tool instruction | -21 tokens |

The old Sol matrix's $0.1942 increase decomposes arithmetically into:

- $0.0806 (41.5%) from the stable +336-token schema/envelope tail;
- $0.0960 (49.4%) from extra output in that historical sample;
- the remainder from cache/input variation.

The output portion is not reproducible as a stable mechanism. It disappears in
the deterministic arms, the current-versus-legacy envelope arm, the
full-versus-minimal schema arm, and the Sol/medium minimal transport
replication. It should be treated as model/sample behavior, not fixed with a
protocol hack.

## The schema also reaches the main agent

The public tool schema is serialized for the driver and is cacheable. In equal
cache strata, current versus legacy adds exactly 214 fresh tokens. The original
completion benchmark measured observer cost only, so its +16.7% did not include
any driver cost.

Actual driver billing is a staircase:

- Luna and Sol usually kept the same cached block and paid the 214-token tail.
- Terra's larger schema crossed the next cache boundary, increasing cache read
  by 512 tokens and making the larger schema cheaper in that captured context.

All 72 exact driver replies and all 24 current/compact head-addition requests
followed their behavioral contract. This verifies serialization and basic
tool understanding; it does not make schema size free.

## OpenAI cache accounting is block-quantized and intermittently inconsistent

The current backend caches in 512-token steps. A Terra padding probe measured:

| Added approximate schema tokens | Fresh input | Cache read |
|---:|---:|---:|
| 0 | 523 | 3,584 |
| 260 | 271 | 4,096 |
| 520 | 531 | 4,096 |
| 1,036 | 535 | 4,608 |
| 2,053 | 528 | 5,632 |

This explains why a stable schema can remain wholly fresh until it crosses a
cache block, and why adding meaningless padding can appear to lower cost.
Padding is benchmark gaming and is rejected.

There is also a separate backend consistency failure. Byte-identical warm
requests intermittently report zero cache, and simultaneous identical readers
can split between a full hit and zero. The dependency-free reproducer is filed
as [openai/codex#33821](https://github.com/openai/codex/issues/33821). It
currently has no maintainer response.

Hydra's heads run in parallel. Cost therefore sums across heads, while
per-observation duration is not a serial pause imposed on the driver. The
latency consequence is later feedback, not a two-head blocking delay. Serial
head coordination could reduce cache races, but would directly delay the
second lens and is not justified by the measured economics.

## Tested solutions

### Keep: deduplicate the OpenAI judge envelope

The current judge envelope defines delivery meanings twice. A semantically
equivalent envelope states lens authority, scope, suppression/deduplication,
tool denial, completion cardinality, delivery routing, and message constraints
once.

It saves exactly 126 fresh tokens in matched cache strata. With the full public
schema, current and deduplicated envelopes each surfaced all positive findings
in 36/36 low-and-medium requests across Luna, Terra, and Sol. All completion
calls were valid.

This is the clean fix: no schema or user-facing API change, no delay, and no
head-specific exception.

### Reject: compact the public schema

The all-at-once compact schema saved 168 fresh tokens but reduced positive
detection from 59/60 to 55/60 in the pooled natural checks. A focused Luna
security replication produced 7/16 findings with the full schema and 3/16 with
the compact schema.

The reverse ablation showed that shortening the long tool description caused
most of the risk. Shortening only field descriptions saved 45 tokens, but the
replication still scored 30/36 versus 32/36. Forty-five tokens is not worth a
plausible quality regression.

### Reject: cache-boundary padding or artificial staggering

- Padding improves the reported cache result by adding meaningless tokens.
- A fixed delay trades away the product's feedback latency and cannot repair
  the backend's intermittent zero-cache reads reliably.
- Serializing two heads trades away independent parallel review for a small,
  variable cache discount.

## Recommendation

1. Keep the Anthropic JSON completion fallback.
2. Keep the full shared public schema.
3. Implement only the OpenAI judge-envelope deduplication.
4. Keep reporting token-weighted cache efficiency and expose zero-cache calls;
   do not use cache hit percentage as a standalone quality target.
5. Track the upstream cache split, but do not hide it with padding, retries, or
   user-visible delay.

## Limits

- Fable was deliberately excluded, and Anthropic high/xhigh were not run.
- The captured trajectory's two supposed negative fixtures contain real
  defects: an empty HMAC secret remains accepted and hook failures remain
  swallowed. They cannot honestly be scored as no-op controls.
- Luna low is intrinsically weak on the security-positive checkpoint, so
  candidate comparisons were replicated and judged directionally rather than
  from one pass.
- Backend cache behavior is volatile. Exact token deltas are stable within
  matched cache strata; aggregate cost and latency are not.
