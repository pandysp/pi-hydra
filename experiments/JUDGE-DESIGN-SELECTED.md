# Judge design — selected expanded 2Q / dual catalog

Status: **selected by Andreas and implemented, 2026-08-04; frozen-sample
mechanics measured, final semantic contract approval pending.**

Evidence base: `JUDGE-DESIGN-UNDERSTAND.md`. The four perspective drafts that
preceded this choice are retained only as terse rejection records. This design
supersedes them.

## Goal

Measure which observer design finds more real severe and minor issues while
producing fewer severe and minor false reports. Known items should be counted
mechanically. Expensive truth judgment should be reserved for genuinely new
material. Quality, cost, and delivery remain separate axes.

## The design in one paragraph

Maintain two versioned catalogs: known real issues and known false-positive
claims. For each observer-reported finding, judges first match its central
claim against both catalogs. Catalog metadata supplies truth and severity; a
known item is never re-proven. Only unmatched findings are judged for truth and
severity. Sol and Opus judge independently in one call if the combined prompt
proves reliable. When they disagree on an unmatched item, Andreas decides from
the blinded evidence and both rationales instead of buying more model
deliberation. The resulting item enters the appropriate catalog at the next
version boundary, then every frozen arm is rescored.

## The two catalogs

### Real-issue catalog

The existing golden dataset, simplified to the properties scoring needs:

- stable id and task;
- precise issue statement;
- `severe` or `minor`;
- evidence/provenance and applicability to the evaluated code state;
- recorded dissent where truth or severity was not unanimous.

`severe` corresponds to the current blocking tier; `minor` corresponds to the
current harmful-but-non-blocking tier. The exact established rubric remains in
force until deliberately changed.

### False-positive catalog

Built over time through the same versioned discipline:

- stable id and task;
- the precise proposition that is false, not merely similar wording;
- `severe` or `minor` false-report severity;
- why it is false and the code-state boundary on which that conclusion rests;
- provenance and any carried dissent.

A severely false report is one whose acceptance could cause a dangerous wrong
change or materially misdirect the current work. A minor false report wastes
attention but is unlikely to cause serious damage. The implementation seeds two
settled minor examples and one settled severe example; catalog validation binds
their exact provenance and applicability.

Neither catalog is shown to observer heads. Both are frozen before an
iteration's score is read.

## One judgment pass, two questions

The intended unit is the observer-authored finding, not a judge-invented atomic
claim list.

For every finding:

1. **Matching:** which real-catalog or false-catalog entries express the same
   central proposition in the same code context?
2. **Unmatched residue:** if no catalog match exists, is the central proposition
   real, false, or genuinely unclear, and is it severe or minor?

The judge sees the delivered finding, visible driver transcript, exact tracked
file state, and both task catalogs with labels hidden behind neutral keys. It
must quote the finding span supporting every match.

The provisional response shape is deliberately smaller than today's contract:

```json
{
  "findings": [
    {
      "id": "j01",
      "realMatches": ["r03"],
      "falseMatches": [],
      "quote": "exact words from the finding",
      "unmatched": null,
      "reasoning": "under 240 chars"
    },
    {
      "id": "j02",
      "realMatches": [],
      "falseMatches": [],
      "quote": "exact words from the finding",
      "unmatched": {
        "truth": "real",
        "severity": "minor"
      },
      "reasoning": "under 240 chars"
    }
  ]
}
```

Required mechanical checks:

- every input finding appears exactly once and in order;
- every quoted span occurs in that finding;
- catalog keys exist and are not duplicated;
- `realMatches` and `falseMatches` cannot both be non-empty;
- a matched finding has no unmatched classification;
- an unmatched finding has no catalog match;
- schema failure gets at most one format-only correction.

## The mixed true/false boundary

The four score buckets are intended to be exclusive for the finding's
**central proposition**. The selected design does not atomize a finding to
extract and severity-grade every attached embellishment. That would recreate
the machinery this design removes.

Frozen-data audit result and selected rule:

- classify and score the central proposition;
- a wholly false central proposition belongs in the false-positive lane;
- **do not include `unsupportedExtra` in the scored contract**;
- observer heads are already instructed to emit each distinct finding as its
  own entry, so genuinely separate defects should normally arrive separately.

The read-only audit covered all 371 frozen capstone findings. Raw judges flagged
18 findings (4.9%), but only one was flagged by both judges; 17 were Sol-only.
Manual review found one clear material false elaboration, five minor
overstatements, and twelve judge errors or policy ambiguities. A deliberately
harsh either-judge penalty changed no MAIN-versus-ENUM conclusion; counting only
the one clear case moved fresh ENUM precision from 80.6% to 80.3%. Rebuilding
claim decomposition around one clear case would cost more reliability than it
buys.

The accepted loss is explicit: a rare otherwise-real finding may carry a false
extra consequence without a separate score. If severe mixed claims recur in
later data, reopen the boundary from those concrete examples; do not add a
second false-fragment catalog speculatively.

Audit sources:
`artifacts/2026-08-04-capstone-consensus/{fresh,old}-packet.json.gz` and
`consensus-final.json.gz`, checked against the frozen fresh and old rows and
payloads. The one clear case is source key
`019fc512-1c19-7e5d-9c67-4574c488f3f5/scheduler/sol-xhigh/scheduler/sol-xhigh/a1/r3/23/ENUM-SO2/f0`:
the real completion-failure defect was accompanied by the false claim that an
owner mismatch increments attempts, although the code returns `null`.

## Code-based counting

The catalogs make four source buckets mechanical:

1. real and severe;
2. real but minor;
3. severely false;
4. false but minor.

They do not become one fused score.

- **Severe recall:** distinct live severe real ids reported / live severe real
  ids in that cell.
- **Minor recall:** distinct live minor real ids reported / live minor real ids
  in that cell.
- **Severe false burden:** severe-false matched occurrences per trajectory and
  per 100 observation points, with distinct ids also shown.
- **Minor false burden:** the same for minor-false matches.

Real issues count once toward recall no matter how often they are repeated.
False reports retain an occurrence count because repeating the same bad advice
is itself product harm. Precision may be derived as a convenience diagnostic,
but the four source measures stay visible.

The reading order remains lexicographic: severe recall first, then minor
recall, then severe false burden, then minor false burden. Cost and delivery
are read beside quality, never folded into it.

## Disagreement and human authority

Sol and Opus remain independent first-pass judges for unmatched truth and
severity. Agreement is accepted for the iteration. Disagreement is shown to
Andreas with:

- observer arm, model and cost hidden;
- the finding and exact visible evidence;
- both judges' original rationales;
- the proposed catalog record.

Andreas chooses real/false/unclear and severe/minor, or preserves the item as
unresolved. There are no persuasion rounds and no analyst model with a third
vote. The original disagreement remains in provenance.

Matching disagreement is load-bearing because a match imports truth and
severity. The implemented rule therefore requires exact match-set agreement;
every matching disagreement enters the same blinded human queue as unmatched
truth/severity disagreement. No union, intersection, majority, or single-judge
matcher is authoritative.

## Catalog growth and freeze discipline

After each iteration:

1. Deduplicate unmatched items against both catalogs and recorded rejections.
2. Apply the independent judgments and any blinded human rulings.
3. Add settled real and false items to new catalog versions; preserve unclear
   items and dissent without forcing a label.
4. Freeze catalog bytes and evaluator builder hashes.
5. Rescore all frozen observer outputs mechanically.
6. Run the raw-data pass before reading a product verdict.

Catalog growth is prospective. No item is added, removed, relabeled, or
reworded to rescue an arm after its result is known.

## What was retained from the discarded drafts

- **2Q:** closed catalog matching, exact spans, open novelty, and deletion of
  judge-authored claim alignment. This is the foundation.
- **Banded Ruler:** compare paired trajectory points and allow the conclusion
  `not separated` when the evidence cannot resolve a winner. Exact uncertainty
  reporting is a later scoring choice, not part of the judge call.
- **Sealed Ledger:** every eligible finding must end in a visible terminal
  state, plus a small seeded audit of matches and misses after scoring.
- **Cost/latency:** checkpoint every batch and spend further judgment only on
  unmatched or disputed work.

## Cheap verification result

1. **COMPLETE:** audit `unsupportedExtra`; omit it from scoring under the result
   recorded above.
2. **COMPLETE:** a conservative provisional false-positive catalog contains
   three settled records selected without arm totals: one severe and two minor.
3. **COMPLETE:** both current Pi replay routes passed live probes. On the frozen
   20-point / 45-finding sample, all outputs were terminally valid; exact outcome
   agreement was 33/45 (73.3%), catalog disposition agreement 38/45 (84.4%),
   and unmatched truth+severity agreement 19/24 (79.2%). Sol used 20 calls with
   no corrections; Opus used 20 initial calls plus five successful format
   corrections.
4. **PARTIAL:** all 12 disagreements were manually inspected. The current
   deterministic packet includes five distinct matched records and five misses
   across all three tasks, plus the complete hash-bound catalog statements.
   Final agreement/miss sign-off waits for the semantic decision below.
5. **BLOCKED CORRECTLY:** iteration-1 four-bucket rescoring waits for the settled
   iteration-2 catalog repairs and explicit live/excluded denominator partition.
   Old atomized outcomes are not silently reinterpreted as expanded-2Q results.

The sample is mechanics evidence against catalog v2 only. Its prompts remain
byte-identical after implementation hardening, but any catalog fold creates a
new identity and cannot pool these outputs.

### V3 follow-up — 2026-08-09

The exact frozen sample was rerun after the v3 fold. Sol completed 45/45;
Opus completed 42/45. One three-finding point returned `toolUse` once; the
registered policy makes non-terminal provider stops terminal-invalid and
ineligible for format correction. Across the checkpoint there were 22 initial
attempts (including two timeout failures at a different point) and three
successful format-correction attempts. Reconciliation found 34/42 exact
agreements among jointly valid findings, eight disagreements, and 23 agreed
catalog-growth candidates. Both checkpoint files are frozen with the
reconciliation in `2026-08-09-expanded-2q-v3-rescore`.

This closes the provider-availability blocker, not the semantic gate. The
catalog changed while the prompt stayed fixed, so the result is not a prompt
A/B. The eight disagreements reproduce the requested-test/process-advice,
alias, and documentation-reachability ambiguities below. A prose-prompt A/B
before those rules are chosen would optimize agreement against an undefined
correctness target. If mechanical reliability is tested separately, the
smallest causal comparison is the frozen replay carrier as-is versus the same
carrier with tools removed; validity, correction, and terminal-invalid rates
are the outcomes, not semantic agreement.

## Final semantic approval gate

In the v2 mechanics sample, eight of the 12 disagreements concern a requested
test that was not delivered. The v3 pair has eight total disagreements and
reproduces the same boundary rather than resolving it.
The prompt currently says process advice without a shown behavior defect is
false/minor; parts of the real catalog treat missing explicitly requested
coverage as a real/minor delivery defect. Andreas must choose one rule before a
full pass. Smaller confirmations are whether multiple matches are allowed only
for true aliases of the same main proposition, and how reachable a hypothetical
documentation concern must be. The agreement audit confirms this is not merely
a disagreement problem: “requested tests still absent” matched a real record,
while imperative “add those tests” findings were agreed false/minor catalog
misses. Grammar cannot remain the implicit product boundary.

## Definition of done for the design phase

- **DONE:** The matching-disagreement rule is selected from measured evidence.
- **DONE:** The false-severity rubric is demonstrated on concrete examples.
- **DONE:** The mixed-content decision remains grounded in the completed audit.
- **DONE MECHANICALLY:** The provisional contract passes the frozen-sample check on both judges.
- **DONE:** Every output is mechanically countable into the four source buckets or the
  explicit unresolved lane.
- **OPEN:** Andreas approves the final semantic contract before iteration 2 resumes.
