# Unified-API screen — A0 / J / F results (2026-07-31, v2)

> **SUPERSEDED IN PART.** This document's quality verdicts use the OLD metric
> (precision on ONE seeded finding per case), which cannot express recall. The
> resolved metric is in [`SEVERITY-V4-BLOCKING-TIER.md`](SEVERITY-V4-BLOCKING-TIER.md)
> and the deliberated reference set in [`CONSENSUS-RESULTS.md`](CONSENSUS-RESULTS.md).
> The routing and cost numbers here stand; the quality ordering may not.


v2 supersedes v1 (commit `4c61ceb`), which was written from the two-config
state and claimed "better AND cheaper than the incumbent on both providers."
That cost claim did not replicate on the two additional families and v1's
Anthropic cost basis underpriced arm envelopes; the corrected story is below.
Nothing in v1's channel verdict changes.

Artifacts: `experiments/artifacts/2026-07-31-unified-screen/` (gzipped rows +
`verdict.json` + SHA256SUMS; also mirrored with the live files in
`~/dev/personal/pi-hydra-frozen-artifacts/`). 340 producer rows (17 cases × 2
samples × {3 arms × sonnet/terra-medium, 2 arms × opus/luna-medium}), 1,116
blind judgments (corrected 2026-08-01 from "1,094" — the frozen files and
`verdict.json.judgments` both hold 1116; 558 per judge, zero duplicate
(judge, metric, sourceKey) keys, zero orphans. No rate changes: the error
was in the doc's evidence-volume sentence only), all 10 config/arm cells
fully judged (`judgedComplete: true`),
zero judge failures, zero refusals, zero excursions, zero truncations. The
instrument was hardened mid-screen (commit `ba636ad`, from the wave-5 audit)
before any verdict was read from the added families.

## Verdict, in three layers

### 1. CHANNEL — settled. The footer replaces JSON.

With the envelope held byte-identical (F−J isolation), the natural-text +
`DELIVERY:` footer beats the three-field JSON channel on every axis that
distinguishes them:

- Routing: bucket +11.8pp on sonnet (the only thing that moved sonnet's
  routing at all — the envelope alone left it at exactly A0's 64.7%), +8.8pp
  on terra.
- Economics: F is cheaper than J everywhere measured (terra $0.003038 vs
  $0.003759; sonnet output 118.8 vs 145.8 tokens — the `reason` field is ~30
  tokens of overhead the footer never pays).
- Quality: flat on sonnet (96.2 = 96.2), −3.9pp central / −3.9pp strict on
  terra (n≈26, inside noise).

J is refuted on its own pre-committed rule (R1: sonnet routing never moved).
This also resolves the corpus's central tension by scope: C's matrix-scale
failure was its envelope+ledger bundle, not the footer channel.

### 2. ROUTING vs A0 — real, pooled; not a per-family guarantee.

F beats A0 on delivery-bucket routing in all four families (+11.8, +20.6,
+11.8, +14.7pp), but case-level paired sign tests put honest error bars on it:
terra p=0.016 alone; sonnet rides on 2 discordant cases (p=0.50), opus 3/1,
luna 5/3. **Pooled across families: 17 gain-cases vs 4 loss-cases, p=0.007.**
Claim it as a cross-family effect, never as "proven on model X" except terra.

### 3. ECONOMICS vs A0 — model-dependent trade: envelope tax vs output savings.

The unified envelope is ~+130 uncached input tokens/obs vs A0's minimal
prompt (measured directly on OpenAI: 704 vs 575). The channel then saves
output on some models (terra −57, sonnet −23 tokens) and not others (opus
+10, luna +2). Three accountings, all reported because none is alone
sufficient:

| Accounting | sonnet | terra | opus | luna |
|---|---:|---:|---:|---:|
| Measured harness cost (OpenAI clean; Anthropic prefix-subsidized pre-`ba636ad`) | −11.0% | **−14.8%** | +6.5% | +9.8% |
| Design tokens, equal-weight (uncached in + out; the hardened R3) | −16% | +10.0% (fail by 0.2 tok) | +5.1% | +18.2% (fail) |
| Production-priced (input at input rate, output at output rate) | ≈+8% | **≈−15%** | ≈+10–20% | ≈+10% |

Reading: the equal-weight token gate misfires on terra (output costs 6× input
there; F's trade is dollar-positive). The dollar-honest summary is: **F wins
terra outright, is single-digit-% more expensive on sonnet/luna, and costs the
most on opus (+10–20%)** — bounded, and small in absolute terms (all cells are
fractions of a cent per observation). The cost driver is the *envelope*, not
the channel (F < J everywhere); a envelope-trim pass is the identified lever
if opus/luna economy matters.

## Quality vs A0 (all cells fully judged, opus+sol unanimous)

| Family | central quality A0→F | strict quality A0→F |
|---|---|---|
| sonnet | 84.6 → **96.2** | 65.4 → 61.5 (the one strict regression) |
| terra | 73.1 → 76.9 | 61.5 → **69.2** |
| opus | 88.5 → 84.6 (−3.9pp, inside R2) | 46.2 → **65.4** (+19.2pp) |
| luna | 76.9 → 73.1 (−3.8pp, inside R2) | 61.5 → 57.7 |

No family breaches the pre-committed −5pp floor. Strict quality *improves*
where it was worst (opus +19pp, terra +8pp); sonnet's mild strict dip
(unsupported side-claims in natural text) is the targeted wording follow-up.

## Recommendation

Adopt **F as the unified judge-completion surface**: natural finding + strict
`DELIVERY:` footer, byte-identical contract text on both providers, terse
single-statement envelope carrying the two causally-proven clauses,
management-only public schema, provider-specific packaging only where the
evidence forces it (combined-user on Anthropic; user-lens + developer envelope
on OpenAI — entitlement-safe). The channel choice is unambiguous; the envelope
cost/quality trade is favorable on balance (routing +12–21pp everywhere,
central quality within noise or better, strict quality up on 2 families, cost
bounded at ≈±15%) — but cost vs A0 on opus/luna is a genuine judgment call
for Andreas, with envelope-trimming as the follow-up lever.

## Instrument changes applied mid-screen (`ba636ad`)

Gates hard-stop on incomplete judgments (previously a half-judged config
scored quality 0 and PASSED R2); judgment dedupe; R3 verdict moved off the
synthetic-prefix cost ratio; one-call reported as by-construction for
fail-open contracts (it is an invariant, not a measurement, for A0/J); refusal
scan extended to fail-open arms; warm call now warms the driver context only,
so future Anthropic rows price the observation prompt as uncached input
exactly as production does (rows in THIS screen predate that fix — their
Anthropic input column reads ~2 and their cost subsidizes the envelope).

## Known limits

1. One corpus (12 fresh screen cases + 5 empty-state dev cases), medium
   reasoning only, samples=2. Golden-41 untouched. Not comparable to the
   frozen ABC table (placement, schema, dedup all deliberately different).
2. Sonnet routing evidence = 2 cases; the pooled claim is the defensible one.
3. Production-priced Anthropic figures are arithmetic corrections, not
   measurements; the next screen (post-`ba636ad`) measures them directly.
4. Deferred: acting-head channel+schema smoke (the remaining open piece of
   the API surface), F+state ledger isolation, delivery/none rename,
   envelope-trim pass, sonnet strict-quality wording.

## Next wave inputs

- Acting smoke: typed tool vs JSON vs footer for acting heads under
  management-only vs wide schema, real agent loop, both providers.
- Envelope-trim: one factor (envelope length), holding channel F constant —
  targets the opus/luna cost cells and the sonnet strict dip together.
- F+state: the bounded same-head ledger as the isolated second factor.
