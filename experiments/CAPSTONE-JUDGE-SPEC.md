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
