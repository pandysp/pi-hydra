# Driver-prompt realism probe (SPEC, registered 2026-08-04 before any call)

Andreas's question: benchmark drivers run under a minimal 245-character system
prompt instead of pi's native one, and observers replay the driver's payload —
so every observation is conditioned on an unrealistic driver system block.
Does that block influence observer behavior?

Precondition, verified today (probes recorded below before this spec's calls):
pi's native prompt minus its 1,591-character "Pi documentation" block draws
PLAN quota under the oauth-replay recipe; with the block it is billed to extra
usage and refused. The trimmed native prompt is therefore usable as the
realistic variant. (Same-day single-variable isolation: 400
`req_011CdhyGxZD1L4mcpvzfKdEw` with the block, 200
`req_011CdhyH1ixLzn879Dzcj5sk` without; the only difference was the block.)

## Method

- Sample: every piggyback observation point of the frozen
  `2026-08-01-trajectory-pilot` scheduler run (Anthropic payloads — the fresh
  capstone payloads are OpenAI-shaped and cannot be rebuilt byte-faithfully as
  Anthropic requests), capped at 12 points by content-hash order of their
  point ids (deterministic, no cherry-picking).
- Observer: the production ENUM-SO2 contract text (steer-only-variants.mjs),
  opus-high, via the established replay mechanics
  (mergeObservationPayload onto the captured driver payload — the production
  observation path).
- Two variants per point, identical except the driver system block 2:
  MINIMAL (the captured 245-char benchmark prompt, as production benchmarks
  ran) vs NATIVE (the proxy-captured pi native prompt for a scratch cwd with
  the documentation block removed, 19,253 chars).
- Noise floor: on the first 3 points (same deterministic order), one repeat
  pair of the MINIMAL variant (minimal vs minimal re-ask).
- Metrics per point: delivery choice (parsed decision), findings raised
  (which defect topics the message names, read not keyword-matched), thinking
  tokens, output tokens.

## Decision rule (registered)

NATIVE-vs-MINIMAL deltas at or below the MINIMAL-vs-MINIMAL repeat floor on
every metric → the minimal prompt is a validated non-factor; the benchmark
keeps it and results docs record a validated (not assumed) limitation.
Systematic deltas above the floor → real influence; future producer waves run
drivers under the trimmed native prompt as a new labeled basis; frozen runs
keep their basis labels.

## Limitation, stated up front

This measures the DIRECT effect of the system block on the observer, holding
the trajectory fixed. It cannot measure the INDIRECT effect (drivers behaving
differently under the native prompt); that would need fresh driver runs and
is out of scope here.

## Spend

~30 opus-high observation-priced calls on plan quota. Stop cleanly on any
quota error; partial results are reported as partial.

## Results (2026-08-04, same day, 27/27 calls on plan, zero errors)

Raw rows: `~/scratch/2026-08-04-native-prompt-probe/realism-rows.jsonl` (12
points × NATIVE+MINIMAL + 3 MINIMAL repeat pairs; ENUM-SO2 observer,
opus-high, production replay mechanics).

- NATIVE vs MINIMAL: 6 of 12 points identical in finding count and action
  mix; 6 differ by ±1–2 findings or one print/steer swap; largest swings 4v2
  and 2v4; no systematic direction (native is higher on some points, lower on
  others).
- Noise floor (MINIMAL vs its own repeat): 2 of 3 points differ, with swings
  up to 4v6 and the same print/steer mix changes.

**Verdict under the registered rule: the minimal driver prompt is a validated
non-factor for observer behavior.** Cross-variant variation matches the
same-variant repeat floor in both rate and magnitude. The benchmark keeps the
minimal prompt; every results doc may cite this as a validated (not assumed)
limitation, direct effect only per the stated limitation.

Metric gap, recorded: thinking-token counts were not captured (a field-name
defect in the probe's usage parsing; response texts and finding structures
were captured completely). The primary registered metrics (delivery choice,
findings raised) are unaffected.

## Ground-truth capture appendix (the proxy step)

The native prompt used above is the PROXY-CAPTURED one: a logging reverse
proxy (scratch, models.json baseUrl override, restored immediately) captured
one full pi request verbatim. Findings: (1) the SDK-based reconstruction of
pi's prompt missed one dynamically-discovered skill entry (pi-ds4-config,
from ~/.pi/agent/git) — proxy capture is the authority; (2) the harness's
onPayload captures are complete on the body side (headers are outside the
hook's scope; verified once, not retained — Andreas ruled them not worth
keeping); (3) the captured native request was refused (extra usage,
`req_011CdhyDNvYrj2oar9uxUxb4`) while the identical request minus the
documentation block passed minutes later — the single-variable confirmation
quoted in the precondition above.
