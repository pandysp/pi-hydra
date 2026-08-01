# Severity consensus protocol — pre-registration (2026-08-01, before data)

## Mandate

Andreas: "I do not want to review the set. It is your and the two judges'
job. Please iterate until you all agree." So severity is settled by
deliberation among three participants — sol, opus, and the analyst — with
no human sign-off. GOLD-SET-DRAFT-FOR-REVIEW.md is retired as a review
artefact; it may be entered as the analyst's opening position, labelled
as such.

## What v2/v4 already established (do not re-litigate)

- Judges agree 90.5% on blocking-vs-rest and 95.2% on any-harm-vs-none;
  61.9% on the 4-level scale. Disagreement is concentrated in the MIDDLE
  (serious vs minor), never more than one step (adjacent agreement 100%).
- `inDeliverable` is a definitional dispute (38.1%), not a fact. DROPPED.
- Judgment is decomposed: judges answer facts, the analyst blends.

## Protocol

Round 1 — INDEPENDENT. Each judge labels every pool issue on the two
reliable axes: `blocking` (yes/no) and `anyHarm` (yes/no), plus a
one-sentence reason. The analyst labels independently too, without seeing
either judge.

Round 2..N — DELIBERATION. For every issue where the three do not agree,
each participant sees the OTHER participants' labels and reasons
(anonymised as "another reviewer"), and may revise or hold with a
restated reason. Positions and revisions are recorded per round.

Termination:
- CONVERGED when all three agree on both axes for an issue.
- An issue that has not converged after 3 deliberation rounds is marked
  UNRESOLVED and carries the majority label with the dissent recorded
  verbatim. It is never silently averaged.
- The run reports: convergence rate per round, which issues needed
  deliberation, which never converged, and every position change with
  its stated reason.

## Pre-registered questions

- **C1**: what fraction of issues converge by round 3? (Deliberation is
  worth keeping iff it converges materially above round-1 agreement of
  ~90%; if it adds < 5pp it is ceremony and should be dropped.)
- **C2**: do position changes follow EVIDENCE or AUTHORITY? Read the
  revision reasons: a judge that flips citing new evidence is
  deliberation working; one that flips citing "the other reviewer" is
  capitulation and invalidates the consensus. Report the split verbatim.
- **C3**: does the converged blocking set differ from round-1 unanimous
  blocking (2 issues on the C2 trajectory)? Report both.
- **C4**: analyst-vs-judges — how often does the analyst's independent
  round-1 label differ, and who moves? This is the check on the analyst
  steering the outcome.

## Rules

- Participants never see arm labels or which arm raised an issue.
- Anonymise participants to each other ("another reviewer"), so a judge
  cannot defer to a model it recognises as stronger.
- Every round's raw positions are stored; the final set is frozen with a
  content hash and becomes the reference for blocking-tier recall.
- Zero producer spend: the pool and messages already exist.
