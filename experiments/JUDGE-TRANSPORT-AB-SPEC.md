# Judge transport A/B — Opus via Claude Code CLI vs Opus via pi (SPEC, registered 2026-08-04)

Funded by Andreas 2026-08-04: do the harnesses carrying a judge model change
its verdicts? The production judges run Sol through pi and Opus through the
Claude Code CLI. This experiment holds the model fixed and swaps the carrier.

**Scope change before any call:** the originally requested Sol arm (codex CLI
vs pi) was descoped by Andreas mid-registration; the experiment is the OPUS
test only. No Sol A/B calls were ever made.

Registered before the first provider call. Diagnostic only: no consensus
votes, no promotions, and the registered judge columns' outputs are never
extended or overwritten.

## Design

- **Transports.** A = Claude Code CLI (`claude -p`, the production opus
  transport). B = pi with the Anthropic provider, invoked through the same
  `piTransport` path the production Sol judge uses. Both passes pin the model
  id `claude-opus-5` explicitly (the production column's `--model opus` alias
  resolves at the CLI; pinning removes alias drift from the comparison) and
  request `high` reasoning. Known, intended carrier differences that this
  test MEASURES rather than controls: each harness maps `high` to its own
  thinking budget, wraps the prompt in its own envelope, and applies its own
  output limits. The judge prompt bytes are identical across transports.
- **Three passes, sequential:** A, then A again (the sampling-noise floor),
  then B. Same sample, same prompts, same frozen dataset bytes: the
  provisional judge basis at
  `artifacts/2026-08-03-openai-capstone-judge-basis/golden-dataset.json.gz`
  (logical SHA-256 `4035950f…`), never the live dataset. Same judge builder
  as the current frozen runner; batch unit one observation point.
- **Parallelism within a pass** (authorized by Andreas 2026-08-04: "You can
  parallelize. The subscription is healthy."): each pass shards its sampled
  observation points over at most 3 workers — shard k takes the points whose
  index mod W equals k in the sorted sample — with one output file per shard
  and a deterministic merge (judgment maps are disjoint by construction;
  batches concatenate in point order; metadata must be identical across
  shards except the output identity). Passes never overlap each other or the
  registered judge columns. On rate-limit errors the worker count drops and
  the change is recorded; no retrying into the cap.
- **Sample.** From the frozen fresh capstone input
  (`artifacts/2026-08-03-openai-capstone-producer`, semantic-v2 adapter — the
  runner's own `buildFindingItems`, so eligibility is byte-identical to the
  registered Opus column): group the 264 eligible findings by observation
  point; stratify points by task × config (6 strata); within each stratum
  order points by SHA-256 of `judge-transport-ab-v1:<rows sha256>:<pointKey>`
  and take whole points in that order until the stratum reaches at least 7
  findings; stop. Both arms ride along naturally (paired observers share the
  point). The resulting point list, its finding count, and its hash are
  committed as a manifest before the first call; every pass and shard reads
  the same manifest.
- **Login precondition, recorded not judged:** pi's Anthropic access token
  refreshes on use; if expired at pass-B time, one minimal non-judge pi call
  refreshes it first. Both transports meter the same Claude subscription.

## Metrics (registered; no fused score)

Claim splitting is judge-side, so claim counts may differ between passes.
Comparison is at the finding level, on the fields that drive scoring
downstream:

1. **anyCentralSupported** — the finding has at least one claim with
   `centralSupported: true`;
2. **anyUnsupportedExtra** — at least one claim with
   `unsupportedExtra: true`;
3. **matchedIssues** — the union of catalog issue ids over the finding's
   claims, compared as set equality (differences listed per issue id);
4. **claimCount** — exact equality.

For each metric: the A-vs-A2 disagreement count (the noise floor) beside the
A-vs-B and A2-vs-B disagreement counts, over the same findings. Also
reported: parse/correction failures per pass, per-batch latency
distributions, and any usage counts a transport exposes (the plain-text CLI
exposes none; pi exposes token usage — reported one-sided, labelled as such).

**Verdict rule:** the transports are treated as equivalent for judging if the
A-vs-B disagreement count on metrics 1–3 is within the range one would see
from sampling noise alone, judged against the A-vs-A2 floor on the same
findings (exact discordant counts quoted; at n≈40 findings only large
effects are detectable, and the results doc must say what the smallest
detectable difference was). claimCount and latency are reported as
descriptive context, not equivalence criteria. If B systematically diverges
(e.g. loses catalog matches or flips supported findings beyond the floor),
the verdict names the direction and the affected metric — plain counts, no
fused score.

## Boundaries

No consensus formation, no promotions, no scoring, no dataset edits, no
changes to the production JUDGES entries or the registered columns' outputs.
New judge entries and the point filter are additive; the suite must stay
green. No judge call before the two registered Opus columns complete (shared
subscription). Raw outputs freeze under run-id
`2026-08-04-judge-transport-ab`.
