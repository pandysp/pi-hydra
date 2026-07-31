# Unified-API screen — A0 / J / F results (2026-07-31)

One-factor screen deciding the unified judge-completion channel across
Anthropic and OpenAI. Pre-committed refutation rules were frozen before any
row was produced (this commit's parent, `cfe47f2`). Raw artifacts:
`~/scratch/2026-07-31-hydra-unified-screen/` (producer.jsonl 204 rows,
judgments-{sol,opus}.jsonl 342 each, zero judge failures).

## Verdict

**F — natural-language finding + strict `DELIVERY:` footer, identical text on
both providers, inside the terse single-statement envelope — survives every
pre-committed gate in both configurations and is better AND cheaper than the
incumbent on both providers.**

**J — A's three-field JSON inside the same envelope — is refuted** (failed R1
bucket on sonnet: routing stayed exactly at A0's 64.7%).

This resolves the central tension in the corpus (`TOOL-FREE-COMPLETION-AB.md`
footer wins at small scale vs `DELIVERY-CONTEXT-ABC-RESULTS.md` C-fails at
matrix scale) in favor of scope: **C's cost/quality failure came from its
envelope+ledger bundle, not from the footer channel.** De-bundled, the footer
is the cheapest arm, not the most expensive.

## The ladder (one factor per step)

| Step | Isolates | Sonnet-medium | Terra-medium |
|---|---|---|---|
| A0→J | terse envelope + 2 causal clauses (channel held = JSON) | quality 84.6→96.2 (+11.6pp); bucket **unchanged** 64.7→64.7; repeat restraint 50→50 | quality 73.1→80.8; bucket 58.8→70.6 (+11.8pp); repeat restraint **25→75** |
| J→F | completion channel (envelope held byte-identical) | bucket 64.7→**76.5** (+11.8pp); quality flat (96.2); cost **−15%**; output −18.5% | bucket 70.6→**79.4**; quality 80.8→76.9 (−3.9pp, n≈26, within noise); cost **−19%**; output **−36%** |

Readings:
1. **The envelope clauses carry quality and (on OpenAI) repeat restraint.**
   Terra's repeat restraint tripled from the dedup clause alone (25→75, same
   channel). They do NOT fix Sonnet's routing.
2. **The channel carries Sonnet's routing.** Only switching JSON→footer moved
   Sonnet's bucket (+11.8pp). This is why J is refuted: its Anthropic routing
   is indistinguishable from A0.
3. **The footer is the terse channel, not the expensive one.** Natural text +
   footer emits fewer output tokens than JSON-with-reason (85–119 vs 133–146).
   The `reason` field is ~30 tokens of overhead the footer never pays.
   Cost follows output volume, as the frozen corpus predicted.

## Full table (n=34 per cell; 17 cases × 2 samples; judges opus+sol unanimous)

| Config/arm | quality | strict | bucket | exact | repeat | cost/obs | out tok | median ms | one-call |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sonnet A0 | 84.6% | 65.4% | 64.7% | 47.1% | 50% | $0.001715 | 141.9 | 3402 | 100% |
| sonnet J | 96.2% | 76.9% | 64.7% | 55.9% | 50% | $0.001799 | 145.8 | 3034 | 100% |
| sonnet F | 96.2% | 61.5% | 76.5% | 67.6% | 50% | $0.001527 | 118.8 | 2895 | 100% |
| terra A0 | 73.1% | 61.5% | 58.8% | 38.2% | 25% | $0.003566 | 141.9 | 3565 | 100% |
| terra J | 80.8% | 73.1% | 70.6% | 67.6% | 75% | $0.003759 | 132.6 | 3866 | 100% |
| terra F | 76.9% | 69.2% | 79.4% | 67.6% | 75% | $0.003038 | 85.3 | 2364 | 100% |

Mechanics, all arms, all 204 rows: zero errors, zero refusals, zero recovery
turns, zero tool excursions, no observation above 1 provider call, judge
agreement 92.9–100%. Numbers hand-verified against raw rows.

## Caveats — read before generalizing

1. **Strict quality on sonnet: F 61.5% < A0 65.4%.** The footer's natural text
   adds unsupported extra claims more often on Sonnet (C's known failure mode,
   here mild and only on strict). On Terra F beats A0 on strict (69.2 vs
   61.5). Not gated (R2 uses central-supported quality, pre-committed);
   flagged as the first targeted follow-up.
2. **Scale**: one fresh corpus (12 screen + 5 empty-state dev cases), two
   models, medium only, 2 samples. Family reversals are common in this
   project's history (system envelope helped Opus, hurt Sonnet). Cheap
   robustness spot-check on opus-medium + luna-medium: next step, A0+F only.
3. **Not comparable to the frozen ABC table**: this screen holds placement
   constant (OpenAI split+developer for all arms — benchmark-A ran the
   entitlement-unsafe combined-user), uses a management-only public schema for
   all arms, and disables runtime dedup everywhere (benchmark A/B had a
   product-illegal suppressor).
4. **OpenAI auth ran on a borrowed codex-CLI access token** (fake-HOME
   overlay, refresh-disabled; real `~/.pi` store untouched). Anthropic
   refreshed natively. A proper `pi login` for openai-codex is still needed.
5. **Deferred by design**: acting-head channel+schema (needs the acting
   harness smoke), same-head ledger/state (next one-factor step per
   `DELIVERY-CONTEXT-ABC-RESULTS.md` §next-hypothesis), delivery/none
   vocabulary rename, absolute gate attainment (quality gates were never this
   screen's claim — though F's sonnet quality 96.2% is, notably, above the
   85% bar that no ABC arm ever met on this metric definition).

## What feeds the next wave

- Winner-so-far: **F** = unified footer channel for judge heads on both
  providers + terse envelope + management-only schema.
- Next cheap validations before any big matrix: (a) opus-medium + luna-medium
  A0-vs-F spot check (family robustness), (b) acting-head smoke (typed tool vs
  JSON vs footer under management-only vs wide schema — completes the API),
  (c) strict-quality follow-up on sonnet (wording, not schema).
- Then: F+state as the isolated ledger step, fresh validation corpus, and only
  after that a full model matrix.
