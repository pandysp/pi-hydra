# Acting-head channel smoke — T / J / F results (2026-07-31)

Completes the unified-API surface begun in `UNIFIED-API-SCREEN-RESULTS.md`
(judge channel = footer). Question: acting-head completion channel and, coupled
to it, the public schema. Arms, real agent loop, real work tools, deterministic
scoring (no judge): **T** typed `complete_observation` + wide schema, **J**
two-field `{"delivery","message"}` JSON + management-only schema, **F**
`DELIVERY:` footer + management-only schema. Envelope routing+discipline units
byte-identical across arms and to the judge surface (asserted offline,
18-test invariant file). 72 rows: 6 cases × 2 samples × 3 arms ×
{terra-medium, sonnet-medium}. Zero errors. Rows:
`~/scratch/2026-07-31-hydra-acting-smoke/rows.jsonl` (frozen copy in
`experiments/artifacts/`, hash in SHA256SUMS).

## Verdict: acting = J. The wide schema has no surviving rationale.

| Pre-committed rule | Result |
|---|---|
| S3 self-removal = 1.00 calls in every arm/config | **PASS 12/12 cells** — `index.ts:1741` terminality is channel-independent *in practice*; the typed channel's headline 2→1-call advantage was never the channel's |
| S2 calls ≤ T+1 | **PASS with sign reversed**: J *beats* T on calls (3.67 vs 3.75 sonnet; 3.08 vs 3.58 terra) and cost. **Cost corrected 2026-08-01 to per-observation** (the figures previously printed here — $0.177 vs $0.197; $0.153 vs $0.187 — were 12-row CELL TOTALS, not per-task costs, and were misread as per-observation against the judge-head docs): per task J $0.0148 vs T $0.0164 (sonnet), J $0.0128 vs T $0.0156 (terra). The historical "+7 calls, cost erased" for tool-free acting does not reproduce under the unified envelope |
| S4 naming defect on two-field JSON | **Does not reproduce**: J 20/20 valid non-self-removal completions (the 12/36 defect belonged to the retired `"action":"complete_observation"` discriminator shape) |
| S1 F correctness/excursions vs T | correctness flat (sonnet 10=10=10; terra 9/9/8). Scalar excursion rule **fires against F** on sonnet (20 vs 17); by class the delta is errored-`read` noise present in every arm (hydra-class excursions ≈ equal, T included). F also spent 2 recovery turns (terra) where J spent 0 |

Between the two management-only arms, J wins on every economic column and on
validity; F's one-contract-everywhere elegance costs 1 case + 2 recoveries on
terra and ~18% output tokens on sonnet. With S1's letter firing against F and
nothing firing against J, **the acting channel is J**.

## The complete unified API surface (measured at every layer)

- **Judge heads (tools: [])**: natural finding + strict `DELIVERY:` footer.
- **Acting heads**: compact `{"delivery","message"}` JSON.
- **Public schema**: one `hydra` tool, management-only `{operation, head,
  message}` — no completion action anywhere; the driver stops paying the
  135–214-token schema tail for a channel nobody needs.
- **Envelope**: shared routing (both causal clauses) + discipline units,
  byte-identical across providers AND head kinds; head-kind-specific
  tool-status/cardinality; grammar per channel.
- **Packaging (the only provider residue, evidence-forced)**: Anthropic one
  combined user message; OpenAI raw lens + developer envelope.
- Scoping is by **head kind, uniform across providers** — "a judging head is
  just the zero-tool case" — not by provider. Self-removal terminality and
  after-change resolution are channel-independent runtime mechanics.

## Limits

n=12/cell; 1-case differences are inside noise — the strong claims are the
three reversals (S2, S3, S4), which are mechanism results, not rate estimates.
Medium reasoning, two families. Anthropic token columns unreadable per the
known warm-call cache-write accounting (use cost); OpenAI columns clean.
Excursion metric captures all four error classes as of `8b6d156`.

## Next-wave inputs

Envelope-trim pass (opus/luna cost + sonnet strict dip, one factor), F+state
ledger isolation, fresh validation corpus before any full matrix, production
S13 telemetry (completionFallback field) before shipping the footer.
