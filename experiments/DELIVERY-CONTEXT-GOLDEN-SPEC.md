# Delivery context: frozen merge gate

## Goal

Make delivery context factual, bounded, and head-decided without making Hydra
noisier, slower, or provider-specific.

The runtime gives an observation only two facts that its fork may not yet see:

- `lastByThisHead`: the latest delivery from this head accepted by the runtime,
  whether its route reached the user, durable session state, or the driver; and
- `pending`: this head's `queue` or `steer` messages still held in a live Pi
  queue and not yet consumed by the driver.

The head decides whether related feedback should be repeated. The extension
does not suppress it. Visible conversation history remains evidence: explicit
rejection or a material change can justify a follow-up; pending or newly
delivered feedback with no response usually calls for waiting; fixed feedback
should not be repeated.

## Frozen inputs

The production control is commit `350e6f5` on `openai-cache-clean`.

The earlier discovery material remains a regression set, not training data for
the golden set. Its pre-golden hashes are:

| Input | SHA-256 |
|---|---|
| `experiments/completion-protocol-ab.mjs` | `a7a25801065f6f05fb0ec7e3ff51cdd596e071a55eb965d1201b120566849d36` |
| `experiments/tool-free-protocol.mjs` | `ccfee0291fcca465925508ec1cba38691898b2ea680aaa0a206c8d08ad273422` |
| `experiments/envelope-acting-ab.mjs` | `ef8fbd828826cc2d96166d911a0149bf1d936a54aaeb7dcf86d53dbf4d773e2e` |
| `heads/security.md` | `42c33b0c8570c5a201d55b2dceb1a05cadf47c1ee30240dc34f2e21eb937453b` |
| `heads/quality.md` | `dd9b0d691c5cff10fa3abe22a2963d174976a91e11433e0a3b4624a7582109c4` |

The golden corpus contains 41 cases derived from three saved, real Pi
trajectories. Compact snapshots retain the source session and message IDs.
Counterfactual driver reactions are allowed only to expose a decision boundary;
they are labeled and change one fact at a time.

The frozen semantic manifest hash is
`8dcf719754b23296ee8333bd868107841d43f135ce8e47f5498505195d228773`.

| Trajectory | Cases | Natural risks |
|---|---:|---|
| GitHub webhook enrichment | 16 | missing HMAC, hook ordering, async failures, operator settings, destructive repair |
| Login redirect | 12 | open redirects, URL normalization, missing-user auth, tests |
| Diagnostics endpoint | 13 | environment leakage, mutating reversal, verification, deployment settings |

Across the corpus the expected outcomes include genuine `none`, `print`,
`queue`, `steer`, and `interrupt` decisions. The contextual boundaries include:

- fresh findings;
- pending equivalent feedback and sibling-head pending state that production
  deliberately withholds from this head;
- a latest successful delivery absent from the fork;
- visible delivery with no driver response;
- explicit rejection;
- partial and full resolution;
- material change; and
- older visible feedback that the bounded ledger no longer carries.

Minority routes have at least two examples: three `print`, three `queue`, and
two `interrupt` cases. One in-flight destructive action has a one-fact
not-yet-started `steer` counterfactual. A wait case uses a semantic paraphrase
rather than byte-identical delivery text.

Security and quality exercise judge-only completion. The frozen acting-head
regression suite remains a separate gate because its file and tool mutations
need a real workspace, not a static judgment corpus. No golden case is selected
or rewritten after treatment results are visible.

## Compared paths

The required blinded A/B/C comparison is paired and randomized:

1. **A — shipped main:** compact tool-free JSON from `origin/main` at
   `b51c157`, including its exact-message runtime deduplication.
2. **B — typed control:** the typed `hydra` completion path at `350e6f5`,
   including its exact-message runtime deduplication.
3. **C — context treatment:** capability-based tool-free completion for judge-only heads,
   the existing tool loop for acting heads, the bounded same-head factual
   delivery context, and no runtime veto of a valid repeated decision.

Legacy experimental arms may be run on the development corpus as causal
diagnostics. They cannot replace A/B/C and may not be tuned from golden
outcomes.

The provider payload in every arm retains representative driver tool schemas
plus the public Hydra schema, while the judge runtime can execute only its
actual completion channel. This reproduces the production cache-replay
boundary: cached tools remain visible to the model even when unavailable to a
judge-only observation.

The producer matrix is Luna 5.6, Terra 5.6, Sol 5.6, Sonnet 5, Opus 5, and
Fable 5, each at medium and high thinking, with two samples per case and arm.
This is 2,952 producer observations. Model, effort, arm, actual route, expected
route, category, and criticality are hidden from qualitative judges.

Every gated qualitative row requires both Sol 5.6 high and Opus 5 high.
Disagreement is reported and manually adjudicated; it is not averaged away.

## Acceptance criteria

All gates are declared before production implementation.

### Protocol and lifecycle

- Every treatment decision is structurally valid after at most one
  format-only recovery; invalid output is never guessed into a finding.
- At least 95% of judge observations finish in one provider call; none exceeds
  two calls.
- Production-path integration tests lose or duplicate zero accepted
  deliveries across send, consume, synchronous failure, orphan cleanup,
  branch restore, and shutdown.
- `print` never enters driver context. `queue` does not steer the current run.
  `steer` reaches the current run before it continues. `interrupt` aborts and
  reaches the next run.
- The exact same message may be delivered again after explicit rejection. The
  extension does not silently veto the head's decision.

### Contextual judgment

Finding quality is derived from two narrow blind TRUE/FALSE judgments:

- **support:** every factual claim is evidenced by the visible trajectory and
  delivery state; and
- **target:** the message identifies the frozen target or a concretely
  evidenced defect that is at least as consequential.

Both judges must return true for both questions. The route and contextual gold
labels are absent from these prompts. A missing message fails finding quality
deterministically. Improper repetition is a separate narrow TRUE/FALSE
judgment, run only when an expected-`none` case sends a message. A `none`
decision avoids repetition deterministically.

Across each producer configuration separately:

- at least 85% of cases that require feedback deliver the expected finding or
  a blind-judge-equivalent stronger finding;
- at least 90% of pending-equivalent, newly-delivered/no-response, and fully
  resolved cases avoid repeating the covered finding;
- at least 80% of explicit-rejection and material-change cases deliver the
  warranted follow-up;
- at least 85% of unrelated-pending cases preserve the fresh finding; and
- no contextual category collapses to zero on either provider.

C's explicit-rejection recovery may not trail A by more than ten percentage
points. Relative improvement is reported but is not required: exact-message
deduplication can be bypassed by paraphrasing, so a large arm gap may partly
measure wording instability. The runtime guarantee is tested deterministically:
an intentionally repeated byte-identical finding must be deliverable after
rejection. C's improper-repeat rate on expected-`none` cases may not exceed A
by more than ten percentage points.

### Delivery choice

The primary deterministic routing metric has two buckets:

- driver-invisible: `none` or `print`; and
- driver-aware: `queue`, `steer`, or `interrupt`.

Bucket choice is correct in at least 85% of cases for each producer
configuration. Exact route is retained as a diagnostic confusion matrix, not a
gate. False and missed interrupts are surfaced for inspection but have no
separate threshold in this experiment. Any case where C prevents a critical
correct finding or invents an unsupported critical finding is a release
blocker regardless of the aggregate.

### UX and economics

Observer and driver costs are reported separately.

- C median observer latency may be at most 15% above A and p95 at most 20%
  above A on each producer configuration.
- C observer cost may be at most 10% above A per observation on each producer
  configuration. B remains the causal typed-completion comparison.
- Cache-hit ratio may be at most three percentage points below paired A.
  OpenAI zero-read incidents are reported separately rather than
  hidden in the mean.
- Hydra adds no driver provider call for `none` or `print`. Any additional
  driver work caused by intentionally delivered feedback is reported as a
  behavioral consequence, not charged to observer overhead.

## Production boundaries

- Delivery state is extension-owned and bounded: one successful record per
  head plus live pending queue/steer records. Each observation receives only
  its own head's records; the ledger retains sibling records solely for their
  own lifecycle accounting.
- The ledger stores facts, not inferred states such as ignored, rejected,
  partially fixed, or resolved. Heads infer those from the visible trajectory.
- Same-wave heads cannot see a sibling decision that does not yet exist.
- Runtime behavior contains no named-head, named-model, or provider-specific
  delivery-context rule. Existing provider-specific payload placement remains
  because the APIs have different message semantics.
- Acting heads keep their work tools. Judge-only heads are recognized by
  capability (`tools: []`), not by name.

## Evidence required before merge

- deterministic ledger tests and production-path integration tests;
- two-head real Pi sessions covering pending consumption and an intentionally
  repeated rejected finding;
- raw resumable A/B rows, blind judgments, adjudications, and a generated
  summary table;
- current discovery regressions, acting-head regressions, TypeScript, tests,
  formatter/linter, and `git diff --check`;
- architecture and experiment documentation; and
- a focused review and preflight with rejected experimental arms removed or
  clearly archived.
