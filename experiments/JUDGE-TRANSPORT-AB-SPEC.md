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

## Re-scope and first execution attempt — 2026-08-04

Andreas re-scoped this to a quick operational check, outside the registered
experiment program: can Opus judging flip from the Claude Code CLI to pi,
because pi has operational advantages? The Sol codex-vs-pi arm was dropped
before any call (Sol already judges through pi in production). The reduced
design: ONE pi pass over the committed 20-point / 45-finding sample, compared
against the production fresh column's frozen verdicts (which are the
claude-cli side, no separate A pass); an A-repeat noise floor only if
disagreement exceeds a couple of borderline items. No freeze, no ledger
entry. The comparison script's `--pass-a2` became optional for this.

**Attempt result: blocked by transport-specific metering, not by verdicts.**
Both registered Opus columns completed first, as required. The production
verdicts were extracted and filtered to the sample (exactly 45 findings).
Three parallel pi shards then all refused immediately: pi's stored Anthropic
login had expired ~36h earlier; a probe call auto-refreshed the token
successfully, after which the API answered `400 You're out of extra usage.
Add more at claude.ai/settings/usage` — while Opus-via-claude-cli had judged
383 findings on the same subscription the same afternoon. Operationally
decisive either way: the two carriers do not draw usage identically, so a
flip is NOT currently possible regardless of verdict agreement, and any flip
decision must first resolve how pi's Anthropic OAuth is metered.

Everything needed to finish the verdict half is staged and idempotent:
`~/scratch/2026-08-04-judge-transport-ab/` holds the filtered production
pass (`pass-a.json`), the three shard point files, and the staged frozen
dataset bytes (logical SHA-256 verified). When the pi route has usage again,
rerun per shard `s`: `node experiments/capstone-trajectory-judge.mjs
--rows-gz experiments/artifacts/2026-08-03-openai-capstone-producer/rows.jsonl.gz
--payload-dir <scratch>/payloads/payloads --payloads-tar
experiments/artifacts/2026-08-03-openai-capstone-producer/payloads.tar.gz
--dataset <scratch>/golden-dataset.json --points-file
<scratch>/sample-shard-s.json --output <scratch>/pass-b-shard-s.json
--judge opus-pi-ab --eligibility-policy semantic-v2 --expected-findings 264`,
then compare with `judge-transport-ab-compare.mjs --pass-a pass-a.json
--pass-b "pass-b-shard-0.json,pass-b-shard-1.json,pass-b-shard-2.json"`.

**Corrected-shape retest, 2026-08-04 (registered before the call).** Andreas
hypothesized the refusal was request SHAPE: the failed calls went through the
pi-ai compat `streamSimple` shim with a custom judge system prompt and
`tools: []`, while pi's production agent path mimics Claude Code exactly
(identity system line plus the canonical tool roster, per the stealth-mode
block in pi-ai's `anthropic-messages.js`), and production drivers/observers
on Opus draw plan quota. The retest used the byte-equivalent production
shape — the actual `pi` binary, default system prompt, default tools, from a
clean cwd with stdin closed:

    pi -p --no-session --provider anthropic --model claude-opus-5:high \
      --mode json "Reply with exactly the word ok and nothing else."

Result: the identical refusal, `400 invalid_request_error: "You're out of
extra usage. Add more at claude.ai/settings/usage and keep going."`
(request id `req_011CdhsxPHP7WqKTbV34ginD`, exit 0 with an in-band error
stop). The shape hypothesis is therefore REFUTED by direct test: pi's
Anthropic OAuth route is refused at the account level today in every shape,
including production's own. What is true alongside this: producer runs
through the same OAuth route succeeded on 2026-08-01/02, so either the
extra-usage pool was drained between then and now, or Anthropic's plan/extra
classification for this route changed; the two are indistinguishable from
this side. Per the stop rule no shard was attempted and no retries were
burned; one probe call total. The verdict-quality half of the flip check
remains staged and idempotent, exactly as recorded above. Next
discriminator when desired: check claude.ai/settings/usage (user-visible
only), or rerun the probe after the pool refills.

**Route-level correction and completed flip verdict, 2026-08-04 (same day,
later).** The pi-binary refutation above stands as recorded, but its
account-level conclusion is overturned: the coordinator replayed a captured
production payload (trajectory-pilot `scheduler-opus-high-a1-r1-q5.json`)
directly against `/v1/messages` with the pi OAuth token and received 200 ON
PLAN QUOTA minutes after the pi binary was refused — confirming Andreas's
guarantee that the experiment harness never consumes extra usage. A new
`oauth-replay` transport (`--judge opus-pi-ab --shape-payload <captured
payload>`) reproduces that shape verbatim: identity system block, the
captured 6-tool roster, `thinking {adaptive, summarized}`,
`output_config {effort: high}`, `max_tokens 8000`, `stream true`, the three
documented headers; judge line as system block 2, judge prompt as the user
message.

Execution: the shard-0 probe returned 200 and the full pass completed —
45/45 findings across the three shards, zero failures, zero retries, on
plan. The claude-cli noise-floor pass (A2) then ran over the identical
sample (one silent shard death at 13/18, resumed cleanly by the append-only
runner; 45/45, zero failures). Counts over 45 findings, discordant per
field:

| pair | real/not-real | unsupported-extra | catalog sets | claim counts |
|---|---:|---:|---:|---:|
| A vs A2 (same transport, the noise floor) | 5 | 0 | 9 | 10 |
| A vs B (Claude Code vs pi-OAuth replay) | 3 | 0 | 5 | 6 |
| A2 vs B | 2 | 0 | 7 | 4 |

**Verdict: FLIPPABLE.** Cross-transport disagreement sits at or below the
same-transport repeat floor on every field; the carrier adds no detectable
verdict effect beyond ordinary sampling noise. The operational caveat is
inverted from the earlier record: verdict quality permits the flip, and
plan-covered capacity exists on this route — but only through the replayed
production request shape; the pi binary's own fresh requests were still
refused the same hour. Three capped ablations off the working shape (tools
removed; interleaved-thinking beta removed; thinking swapped to
enabled/budget) each still drew plan, so the field that gets a request
classified out of plan coverage remains unisolated — candidates left
untested include system-block content, message/timestamp shapes, token
limits, and SDK-added headers. Until pi itself is confirmed to draw plan
again, any pi-side Opus judging should go through the `oauth-replay`
transport with a captured production payload as its shape source.
