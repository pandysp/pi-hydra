# Expanded 2Q judge pipeline — implementation spec

Status: **implemented and mechanically verified on a frozen sample; semantic
contract approval and iteration-2 catalog repair remain gated below.**

Design of record: `JUDGE-DESIGN-SELECTED.md`.

## Goal and why

Replace the claim-atomizing capstone evaluator with the selected finding-level
pipeline. Known real issues and known invalid reports should be matched once and
counted mechanically. Only genuinely unmatched central propositions should need
fresh truth/severity judgment. Sol and Opus must use the same Pi hook/replay
carrier and a custom judge system message. Existing observer trajectories remain
frozen.

The old pipeline stays reproducible as historical v1 code and artifacts. New
judge checkpoints use a new protocol id and cannot be appended to old state.

## Resolved decisions

### Unit and accepted loss

The unit is one observer-authored finding and its main proposition. A finding
cannot be both matched and unmatched. If an old finding bundled a known issue
and a genuinely different novel issue, the judge chooses the main proposition;
the other issue is not scored. This is an accepted simplification, not an
accidental parser limitation.

The frozen v1 packets show the size of that boundary: 61/371 findings had at
least one old judge extract both a supported known match and a supported
unmatched claim; 14 were mixed for both judges. Agreement and seeded-miss audits
must therefore keep measuring the loss.

### Meaning of real and false

Truth applies to the reported issue, not to isolated factual atoms:

- `real`: the main proposition identifies an actionable defect in this context;
- `false`: it does not identify a defect here, including a wrong premise,
  irrelevant concern, expected behavior, true-but-harmless observation, or
  process advice that asserts no present wrong behavior;
- `unclear`: the visible evidence cannot settle whether it is a defect; severity
  must be `null` rather than invented.

This preserves the four requested product buckets without counting harmless
observations as real minor issues. False-catalog statements must record the
precise invalid *defect proposition* and explain which case above applies.
Testing, inspection, verification, qualification, or conditional-change advice
must not be converted into an invented “missing test coverage” defect.

### Severity

- real `severe`: the established blocking tier;
- real `minor`: the established harmful-but-non-blocking tier;
- false `severe`: accepting the report could plausibly cause a dangerous wrong
  change, remove a safeguard, create correctness/security loss, or materially
  redirect the work;
- false `minor`: accepting it primarily costs bounded investigation,
  clarification, testing, documentation, or a local unnecessary change.

Concrete frozen examples establish both false-severity bands. Minor: a report
claims a Markdown table has a stray brace that is absent, or misreads the
sentence that tenant scoping “has to be represented by” a supplied database
handle as saying the handle *is* tenant-scoped. Accepting either causes a bounded
documentation detour. Severe: `EXP-c-04` alleges cross-tenant leakage even
though the reviewed data model cannot express another tenant's rows; accepting
that security claim would materially redirect the architecture. These settled
records may seed the catalog; the other rejected golden records may not be
mechanically inverted.

### Judge disagreement

Only exact outcome agreement is automatic. Match arrays are compared as sets.
Any of the following enters the same blinded human queue:

- different real-match sets;
- different false-match sets;
- matched versus unmatched;
- real versus false versus unclear;
- severe versus minor.

No union, intersection, majority vote, persuasion round, or analyst-model vote
is allowed. Andreas sees the finding, exact evidence, both original rationales,
and a proposed record under opaque ids with arm, config, model identity, and cost
hidden. Agreed `unclear` stays unresolved unless Andreas elects to rule on it.
A deterministic seeded sample of agreements and misses is audited after scores
are computed.

### Catalog growth and mechanical rescoring

Adding a catalog record does not retroactively attach its id to old unmatched
outputs. A frozen occurrence ledger is therefore first-class:

```text
source finding -> blinded reconciliation -> settled decision
               -> unmatched cluster -> catalog id(s) -> occurrence ledger
```

The ledger may contain final real/false catalog ids or an explicit unresolved
state. Every settled unmatched occurrence must be mapped to a frozen catalog id
before quality scoring. If a later catalog version lacks an occurrence mapping,
semantic rematching is a new evaluation pass, not a “free rescore.”

### Iteration-2 checkpoint

- Preserve completed steps 1–2 and all dissent: they are real-catalog repair
  evidence, independent of the evaluator contract. The settled scratch record
  contains 25 fold-ready outcomes: two statement replacements, the RG21
  Option-A termination, two anchor repairs, the adopted anchor rule, and 19
  adopted backfill anchors. RG22 is harmful/minor, not blocking/severe.
- Preserve the six Sol-only residue votes as incomplete old-protocol evidence;
  do not mix them with new judgments.
- Route seven dataset-repair items separately from judge disagreements:
  `AC13B`, `SCHED-c-15`, `DISP-o-xd-g20`, `DISP-o-xd-g26`, `SCHED-o-g07`,
  `SCHED-o-g14`, and `SCHED-r-d18`. The last three were unanimous rejections
  of unfaithful file-wide anchors, not adopted backfills.
- Supersede unstarted old steps 3–4 with the new full 2Q pass.
- Treat the 67 old atomized novel candidates as historical leads, not automatic
  catalog promotions; use them only as a completeness cross-check.
- Steps 5–6 remain unstarted until this pipeline is verified and approved.
- The 12 old run-end findings remain unjudgeable because their final-assistant
  evidence was never frozen.
- Until settled anchors are actually folded, all 33 active records with null
  anchors are explicitly excluded from recall denominators and their severe /
  minor excluded counts are printed. They are never silently counted as live.

## Architecture

### Catalogs

- Real catalog: a validated scoring view over `golden-dataset.json`; no duplicate
  truth store. `blocking -> severe`, `harmful -> minor`.
- False catalog: versioned `false-positive-catalog.json` with stable id, task,
  invalid defect proposition, severity, why invalid, applicable code-state
  boundary, provenance, dissent, and status.
- Every judge checkpoint records both full-file SHA-256 values, versions, and
  per-task rendered catalog hashes.

### Judge contract

The protocol builder returns a stable custom system message separately from the
batch-specific user evidence. One finding produces exactly:

```json
{
  "id": "j01",
  "realMatches": ["r01"],
  "falseMatches": [],
  "quote": "exact finding span",
  "unmatched": null,
  "reasoning": "under 240 chars"
}
```

or the same object with no matches and:

```json
{"truth":"real|false","severity":"severe|minor"}
```

or `{"truth":"unclear","severity":null}`.

Mechanical validation requires exact ids/order/fields, an exact non-empty quote
from the finding, known unique keys, exclusive real/false lanes, exclusive
matched/unmatched state, and a non-empty reasoning string of at most 240
characters. A point may contain at most 12 findings. One fixed format-only
correction is allowed. Tool calls and non-terminal provider stops are terminal
invalid outputs rather than correction candidates.

### Pi replay transport

Both judges run through Pi's `streamSimple` and provider serialization. A pure
`onPayload` transform replaces the built request with a frozen known-working
production carrier, then replaces only its semantic fields:

- Anthropic: retain the entitlement identity block and carrier fields; put the
  custom judge prompt in system block 2 and Pi's built conversation in
  `messages`.
- OpenAI Codex: put the custom judge prompt in `instructions` and Pi's built
  conversation in `input` while retaining the production carrier fields.

The one correction turn preserves the actual assistant response in its native
assistant role. The checkpoint freezes provider/model/reasoning, system hash,
transform hash, shape source/member/SHA-256, and protocol/builder hashes. The
new runner contains no Claude Code process path and fails closed on provider,
model, or payload-shape mismatch. The correction text is not caller-overridable;
Anthropic's output limit comes from the frozen carrier. A started-but-unanswered
attempt is ambiguous after a crash and requires explicit retry authorization.

### Reconciliation and scoring

Reconciliation produces:

- exact judge agreements;
- a private source-to-opaque-id map;
- a blinded human disagreement queue;
- a blinded catalog-growth queue for agreed unmatched real/false findings;
- unresolved findings.

The private blinding key is a persisted external input, never checkpoint or
repository content. Public review material carries the exact catalog statements
without severity and is verified against the same per-task rendered hashes the
judge checkpoint recorded. This makes both match audits and catalog-miss audits
substantive rather than asking the reviewer to trust an invisible catalog.

After human rulings, deduplication, catalog versioning, and occurrence mapping,
the scorer reports four source measures per task/config/arm:

- distinct severe real ids found / live severe real ids;
- distinct minor real ids found / live minor real ids;
- severe-false occurrences per trajectory and per 100 observation points, plus
  distinct ids;
- minor-false occurrences on the same bases, plus distinct ids.

Repeated real ids count once for recall. Repeated false ids remain repeated
occurrences. Unresolved findings are visible and excluded from all four source
buckets. Every score cell must partition all active task-local real ids into
disjoint `liveRealIds` and `excludedRealIds`; omissions, overlap, and wrong-task
ids fail closed. Cost and delivery remain separate columns.

## Implementation and verification record — 2026-08-04

Implemented modules cover catalog validation, prompt/response contract, Pi
replay transport, resumable judging, exact reconciliation, catalog growth,
occurrence-ledger scoring, deterministic agreement audit, and a frozen-input
manifest. Historical claim-v1 code and artifacts were not mutated.

Fresh current-code route probes reached both registered subscription routes.
Each judge returned 2/2 valid findings with no correction, invalid output, or
unjudgeable evidence. Sol's request completed and checkpointed but its
websocket kept the Node process alive; the idle process was interrupted only
after the checkpoint was verified complete.

The pre-registered 20-point / 45-finding sample spans all six task × config
strata. Its complete prompts were reconstructed after hardening: all 20 point
keys, all 45 source keys, and every full system+user prompt hash are
byte-identical to the paid runs. The implementation hash changed because
validation code changed; no sampled question changed.

- Sol: 20 initial calls, 20/20 first answers valid, no corrections or terminal
  failures; mean batch latency 16.8 s.
- Opus: 20 initial calls, 15/20 first answers valid, five successful format
  corrections, no terminal failures; mean batch latency 13.9 s.
- Exact outcome agreement: 33/45 (73.3%). Catalog disposition agreement:
  38/45 (84.4%). Both judges called 24 findings unmatched; they agreed on
  truth+severity for 19/24 (79.2%).
- Twelve disagreements: six matched-vs-unmatched, five unmatched truth, one
  different match set; no severity-only disagreement.
- Nineteen exact-agreement unmatched real/false findings entered the catalog
  growth queue. No finding was unclear, unjudgeable, or terminal invalid.
- The current stratified audit packet samples five different matched catalog
  records across all three tasks and five catalog misses across all three
  tasks, with the complete hash-bound task catalogs included.

This is mechanics evidence against current catalog v2, not catalog-ready
iteration-2 evidence. The settled iteration-2 repairs have not been folded;
any catalog change creates a new checkpoint identity and these outcomes may not
be pooled into it.

### Open semantic gate

Manual review of all 12 disagreements exposed one dominant policy ambiguity:
eight concern an explicitly requested test that the implementation did not
provide. The current prompt says process advice without a shown behavior defect
is false/minor, while some real-catalog records treat missing requested coverage
as a real minor defect. Andreas must choose whether failure to deliver an
explicitly requested test is itself real/minor or remains false/minor absent a
shown behavior failure. Two smaller boundaries also need confirmation: a
finding should match multiple ids only when they are aliases of the same main
proposition, and hypothetical documentation concerns need a stated reachability
rule. The stratified agreement audit reproduces the same inconsistency: one
agreed match treats “the requested email tests are still absent” as real, while
agreed catalog misses phrase the same gap as “add email tests” and become
false/minor. That grammar sensitivity is not an acceptable hidden scoring rule.
Do not tune these rules from the sample after the fact.

## Definition of done

1. **DONE:** Catalog validation proves schema, stable ids, task ownership, severity,
   applicability/provenance, content version, and no duplicate active
   propositions.
2. **DONE:** Contract tests reject bad order, non-substring quotes, unknown/duplicate
   keys, cross-lane matches, matched-plus-unmatched, malformed unmatched values,
   extra fields, overlong reasoning, and any non-null severity for `unclear`.
3. **DONE:** Both replay transforms are tested against frozen real payload shapes;
   custom-system placement, no old conversation leakage, model fail-closed,
   correction roles, and immutable shape/system hashes are proven.
4. **DONE:** Resume makes zero calls after completion and refuses input, catalog, system,
   transform, or carrier-shape drift.
5. **DONE:** Reconciliation tests every disagreement class, agreed unclear, human
   resolution, opaque identity, and absence of arm/config/model/cost from the
   public queue.
6. **DONE:** Catalog growth refuses an unmapped settled occurrence; the final ledger maps
   every judgeable finding exactly once to catalog id(s) or unresolved.
7. **DONE:** Scoring tests distinct real recall, repeated false occurrences, distinct
   false ids, unresolved exclusion, and liveness.
8. **DONE:** Historical v1 artifacts and scores remain reproducible without provider
   calls; frozen observer trajectory bytes are unchanged.
9. **DONE:** One minimal Sol and one minimal Opus route probe prove the hooked transport;
   stop immediately on quota classification or schema failure.
10. **DONE:** A deterministic stratified frozen sample measures schema validity, exact
    agreement, every disagreement, and seeded agreements/misses before any full
    judge pass.
11. **DONE:** Manifests, run specs, index, benchmark documentation, handoff, and PR body
    distinguish historical v1 results from the future v2 path.
12. **OPEN:** Andreas approves the measured final contract before iteration 2 resumes.

## Boundaries

- Do not regenerate observer messages solely to replace the minimal benchmark
  driver prompt. The measured direct effect was within repeat noise.
- If future dataset changes require regenerating observations anyway, use the
  trimmed native driver prompt for the new labeled basis.
- Do not mutate old judge checkpoints, consensus artifacts, or published
  iteration-1 numbers.
- Do not call a semantic rematch a mechanical rescore.
- Do not tune catalogs or severity after reading arm totals.
