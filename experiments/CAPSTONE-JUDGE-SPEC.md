# Capstone trajectory judging — individual claims, replay-safe (SPEC, 2026-08-02)

Registered before the first Sol call over the frozen OpenAI trajectory. This is
the judging protocol for the producer-first amendment in `BENCHMARK-SPEC.md`.
The first pass fills one Sol column only. It is not consensus, a golden-v2
score, or design evidence while the dataset is provisional and Opus is absent.

## Why a new adapter is necessary

The frozen OpenAI run contains 78 delivered messages but 119 emitted findings.
ENUM frequently uses several independently routed findings in one response;
MAIN and F2 normally emit one. Treating a response as one claim would give ENUM
less denominator simply because its API supports an array. Treating newline
fragments or JSON fields as claims would create the opposite format bias.

Each judge therefore reads each emitted finding separately and splits it into
atomic defect claims. A finding that names two distinct defects produces two
claims. A factual embellishment about the same defect stays attached and is
recorded as `unsupportedExtra`. A process-only note may produce no claim.

## Frozen questions

For every atomic claim, each judge independently records:

1. a neutral one-sentence statement of the defect;
2. whether its central finding is supported by the exact visible evidence;
3. whether it adds a material unsupported factual assertion;
4. every active task issue in the supplied dataset catalog that describes the
   same underlying defect, or an empty list.

“Same defect” means the same wrong behavior in the same code. Sharing a
function name or naming only a downstream consequence is not a match. Support
uses the calibrated evidence policy from `delivery-context-judge-protocol.mjs`.
Matching and support remain separate: a premature claim may resemble a catalog
entry without being supported at that observation point.

The judge sees the human-inspectable driver request available at that point
(encrypted private reasoning is deliberately removed), plus the exact
tracked-file state. At a run-end point it also needs the final assistant
message that the observer received. The old OpenAI artifact did not store that
message directly: 19 findings can be reconstructed byte-for-byte from the next
frozen request, while 12 findings at the two terminal run ends have no later
request and are registered as `unjudgeable-missing-final-assistant`. They stay
in the artifact and denominator disclosure but receive no invented judgment.
The fresh trajectory runner now freezes the message directly. It sees catalog
statements, but not tiers, votes, consensus, planted labels, producing arm,
delivery route, cost, or expected result. Findings within a point are ordered
by a stable hash of their hidden source key rather than arm order.

## Identity and recovery

The runner fingerprints the protocol source, frozen rows, payload archive,
dataset version, task catalog, rendered evidence, and every prompt. Unjudgeable
rows and their exact reason are checkpointed alongside judgments. A
checkpoint is written atomically after each point. Resume skips completed
source keys, refuses input or protocol drift, retries only failed/pending work,
and never overwrites another judge's file. One format-only correction turn is
allowed and preserved in batch provenance.

Raw judge responses are retained verbatim. After each pass the analyst reads
the original delivered messages, the atomic judgments, and the raw responses;
summary numbers alone are insufficient.

After both columns complete, `capstone-consensus-packet.mjs` first proves that
their rows, payloads, dataset, catalog, judge builder, finding identities, and
unjudgeable evidence holes are identical. It then presents the two independently
split claim lists side by side with stable claim references. It deliberately
does not align claims or decide consensus: the analyst records those semantic
groupings only after reading both raw passes.

## Scoring boundary

No precision or recall result is final until Sol and Opus have answered these
same frozen questions and golden v2 is valid. Final issue groups are formed
from the union of both judges' atomic claims. A catalog issue earns coverage
only when both judges support and match it. A distinct raised issue is real for
precision only when both support it. A distinct issue both call unsupported is
absolute noise. Disagreement remains visible and is never averaged.

Supported unmatched claims enter `pending-opus`; they are not promoted by a
producer, by Sol alone, or by this runner. Promotion still requires Sol, Opus,
and analyst deliberation through the golden-dataset protocol, followed by a
dataset version bump and free re-score.

## First registered input

- rows: `artifacts/2026-08-02-openai-trajectory/rows.jsonl.gz`
- payloads: `artifacts/2026-08-02-openai-trajectory/payloads.tar.gz`
- task: scheduler only
- configs: `sol-high`, `sol-xhigh`
- arms present: `MAIN`, `F2`, `ENUM`
- first judge: `gpt-5.6-sol`, high reasoning, subscription transport
- batch unit: one observation point; concurrency 1
- producer spend: zero

The catalog is the active scheduler slice of candidate dataset version
`2b0a85843c9be981`. If the frozen v2 scheduler catalog differs, affected
matches must be judged in a versioned follow-up; old judgments remain intact.

Replay preflight on 2026-08-03 closed a second identity boundary for this first
input. Opus must run the judge implementation at commit `369ed58` (builder hash
`df3cc0f57a725965`) and the provisional dataset bytes later frozen at
`artifacts/2026-08-03-openai-capstone-judge-basis/golden-dataset.json.gz`
(logical SHA-256
`4035950fd2ff2fbf1ee515f1d3da88f9437eebd15db198d354d305b6f1fce8c0`).
The current working judge and working dataset are not substitutes: both have
advanced since Sol answered. The old 119-finding input and the fresh
264-finding input therefore need separate Opus passes on their own exact
registered builders, even though they share these dataset bytes.

Execution-record amendment, registered 2026-08-04 before this input's first
Opus call: concurrency for this Opus pass is raised from 1 to 3 on Andreas's
authorization. Per-point judge calls are stateless with session persistence
off, so verdict content is order- and concurrency-independent. The pinned
`369ed58` runner runs unmodified per shard: observation rows are split by
judgeable point index modulo 3 in the pinned enumeration order (31 points →
11+10+10; 47+36+36 findings), every evidence row (file-state, driver-turn,
cell markers) is kept in all three shards, and the shard outputs are merged
by a script that refuses metadata drift, duplicates, missing findings, or
counts other than the registered 107 judged + 12 unjudgeable. Resume rules
apply per shard. The shard and merge tools are frozen with the output
artifact.

### First-input Opus execution record — 2026-08-04

Opus (claude-cli transport, effort high) judged the frozen input at the
pinned `369ed58` implementation — the runner reproduced builder hash
`df3cc0f57a725965` exactly — under the concurrency-3 amendment: three
unmodified runner instances over the sharded rows, 29 point batches total,
zero transport failures, zero resumes, zero schema corrections. 107/119
findings judged; the 12 run-end findings without final-assistant evidence
terminated `unjudgeable-missing-final-assistant` — verified identical, key by
key, to the set Sol recorded. The fail-closed merge validated cross-shard
metadata equality, disjointness, full coverage, and the registered 107+12
counts before writing the merged checkpoint. Frozen as
`2026-08-04-openai-trajectory-opus`.

## Second registered input: 2026-08-03 OpenAI capstone producer

Registered before its first Sol judge call. The producer artifact is
`artifacts/2026-08-03-openai-capstone-producer/`:

- stored rows SHA-256: `7224f4e031be4719abc7b6f7570c3972b64c5d5df7e66407b42fba26ffad9e03`;
- payload archive SHA-256: `401c38dfdfd6845ceef5e28a4f1519246c65ee3845fcc07818e9ca1406be4ae7`;
- provisional dataset version: `2b0a85843c9be981`, file SHA-256
  `4035950fd2ff2fbf1ee515f1d3da88f9437eebd15db198d354d305b6f1fce8c0`;
- tasks: scheduler, exporter, dispatcher; configs: sol-high, sol-xhigh;
  arms: MAIN-SO2, ENUM-SO2;
- first judge: `gpt-5.6-sol`, high reasoning, subscription transport;
- batch unit: one observation point; concurrency 1; producer spend zero.

This input uses eligibility policy `semantic-v2`. Cache assertions measure
whether cost is comparable; they do not make a successfully parsed finding
semantically unjudgeable. A delivered finding whose only invalidity is the
registered cache-read floor therefore enters the quality pass with its source
validity preserved as `cache-only-invalid`. All other invalid observations
remain excluded. The one checkpoint spawned from a driver `WebSocket error`
is excluded even though both observer calls returned: it is not a legitimate
post-driver observation point. This versioned policy is frozen before judging;
the earlier Sol artifact remains on strict-v1.

The frozen adapter yields exactly 264 judgeable findings: successful delivered
findings from ordinary valid rows plus cache-only-invalid rows, minus every
finding at the failed-driver checkpoint. A different count is input or adapter
drift and must stop the pass.

## Iteration-2 staged judge work (registered 2026-08-04, NOT run)

Two judge-spend items from the ITERATION1-DATA-PASS lane-A list are staged
here for the coordinator; no calls have been made. Both use the CURRENT
frozen judge builder and the frozen provisional dataset bytes
(`4035950f…`), both judges each, batch unit one observation point.

**A4 — old-input basis unification.** `capstone-old-realign.mjs` verifies
the old input reconstructs to 119 findings under strict-v1 and 131 under
semantic-v2, that the 12 packet-missing findings are exactly the recorded
final-run-end unjudgeables (unrecoverable by construction, not resurrected),
and that the actual re-judging delta is the 12 cache-only-invalid findings
(no F2 among them). Staging output: `--output` writes `rejudge-points.json`
(the 12 sourceKeys). Invocation per judge once approved:

    node experiments/capstone-old-realign.mjs --output ~/scratch/<date>-old-realign
    node experiments/capstone-trajectory-judge.mjs       --rows-gz experiments/artifacts/2026-08-02-openai-trajectory/rows.jsonl.gz       --payloads-tar experiments/artifacts/2026-08-02-openai-trajectory/payloads.tar.gz       --dataset <provisional-basis-bytes> --eligibility-policy semantic-v2       --points-file <the 12 sourceKeys' points> --judge {sol|opus} --output <checkpoint>

**A5 — fresh-input cache-only re-judge under clarified instructions.** The
23 cache-only-invalid fresh findings re-run with ONE added judge-prompt
sentence, registered verbatim here and to be appended to the judge
instructions for these runs only (a builder-hash change, recorded as such):

> A finding marked cache-only-invalid failed only a cost-comparability
> check on its request; its delivered message and all payload evidence are
> complete and fully judgeable — judge it exactly like any valid finding.

Point selection: the 23 sourceKeys with `qualitySourceValidity ==
"cache-only-invalid"` in the frozen fresh packet. Original verdicts remain
immutable; the re-judged verdicts land as a versioned follow-up column and
enter consensus through the standard packet flow. Do not revert the
eligibility policy to strict-v1 — it also rescues 5 real findings.

## Cross-judge consensus execution record — 2026-08-04

Both judge columns complete, the analyst stage ran as a 28-agent workflow
(14 opus-high matchers, one per 27-finding batch; 14 opus-xhigh adversarial
verifiers instructed to refute scoring-critical credits and default to
refusal when uncertain). All 14 coverage checks passed. The verifiers
refuted 6 credits and skipped 1; each of the 7 received an explicit analyst
resolution with its reason recorded in-band (2 refutations upheld, 2 credits
restored with the description narrowed to the shared core and the
overreaching clause carved out as a recorded disagreement, 2 restored with
the novel flag dropped because the statement equals the settled rejection
`EXP-o-xe-g06`, 1 analyst direct verdict for the skipped defect). Mechanics:
`capstone-consensus-apply.mjs` (verifier verdicts) and
`capstone-consensus-resolve.mjs` (analyst resolutions), both fail-closed;
runtime-validated, no dedicated unit tests yet — add them before any
iteration-2 reuse.

Result (artifact `2026-08-04-capstone-consensus`): fresh input 264 findings,
263 credited both-judge defects over 30 catalog issues, 143 recorded
disagreements, 34 novel candidates; old input 107 findings, 140 credited
over 16 catalog issues, 70 disagreements, 33 novel candidates. Credits are
claim-ref-exact; catalog credit uses intersection semantics (an id matched
by only one judge is a recorded disagreement, never credit). Promotion of
novel candidates goes through the dataset consensus protocol as the
registered versioned follow-up; nothing here changes dataset content.

## Second-input execution record (appended after completion)

Sol completed the exact 264/264 findings in 109 accepted batches. Two attempts
returned no response because of transport errors; each resume retried only the
still-unanswered point under identical metadata and prompts. All accepted
answers passed on their first response, so no format-correction answer entered
the checkpoint.

The immutable raw checkpoint, deterministic 264-row judgment export, and audit
summary are frozen under `artifacts/2026-08-03-openai-capstone-sol/`. Their
logical SHA-256 values are respectively
`d19a38b219e7dabc25f35e0b07624cff94f08e74786d221a5b5c205da85ceabe`,
`8cb51785a2cd287c59cf9ec6ec7f5d5e38b60f8ae8d7861b98e315bbadefb537`,
and `00cf599a4c419b1a59941514eab2a669fc8bb253bee54c8582f4a82f6a36b62b`.
This remains one judge column. It neither freezes v2 nor supplies a quality
score.

### Second-input Opus execution record — 2026-08-04

Opus (claude-cli transport, effort high) judged all 264/264 eligible findings
at the current frozen builder `5880bf010bbb428e` — the same builder hash Sol
answered under — against byte-identical frozen inputs (rows `7224f4e0…`,
payloads `401c38df…`, provisional dataset bytes `4035950f…`, policy
`semantic-v2`). 109 accepted batches, zero transport failures, zero
unjudgeable, zero resumes, zero schema corrections, one uninterrupted process
at concurrency 1. Frozen as `2026-08-04-openai-capstone-opus`. Both capstone
judge columns now exist; Sol + Opus + analyst consensus is a separate
registered stage and has not run.

The exact provisional dataset bytes used to render the Sol catalog are also
frozen separately under
`artifacts/2026-08-03-openai-capstone-judge-basis/golden-dataset.json.gz`
(logical SHA-256
`4035950fd2ff2fbf1ee515f1d3da88f9437eebd15db198d354d305b6f1fce8c0`).
This closes a replay gap: when the working dataset advances, Opus can still
answer byte-identical questions from the frozen basis. It must not silently use
the new catalog and call that the same pass; changed final-v2 entries instead
enter the registered versioned follow-up.
