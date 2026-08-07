# Structured context contract: development gate

> **ABANDONED.** v1 was rejected (critical misses); the v2 gate specified
> below was never run — the thread ended when the footer channel won the
> unified-API screen. Recorded here so the gate does not read as pending.

## Hypothesis

The factual envelope is sound, but low-thinking models inconsistently perform
three decisions at once: find a lens issue, relate it to delivery evidence, and
route it. Requiring the head to expose a compact relation before delivery may
improve contextual judgment without a second provider call or runtime semantic
suppression.

This is a contract experiment, not production behavior. The already-frozen
36-case golden corpus and its acceptance criteria remain unchanged.

## Frozen contract

The head chooses exactly one contextual relation:

- `none`: no lens finding warrants feedback;
- `new`: a warranted finding is not covered by related delivery evidence;
- `waiting`: equivalent feedback is pending or has had no driver response;
- `follow_up`: rejection, changed impact, or material new evidence warrants
  another message; or
- `resolved`: the related finding was fixed.

For `none`, `waiting`, and `resolved`, delivery must be `none`; any preceding
text is private rationale and is ignored. For `new` and `follow_up`, a
non-empty natural-language finding and routed delivery are
required. The head chooses both relation and delivery. The runtime validates
only this structural consistency; it never computes equivalence or changes a
valid relation.

Output is one natural-language finding when needed, then two exact footer
lines:

```text
CONTEXT: none|new|waiting|follow_up|resolved
DELIVERY: none|print|queue|steer|interrupt
```

One format-only correction is allowed. Exact footers remain mandatory; private
rationale before a silent decision is not interpreted as feedback. No semantic
retry or parser inference from malformed output is allowed.

## Predeclared development gate

Compare the current evidence-guided treatment and this structured arm on the
separate 13-case development corpus, Terra low and Sonnet low, two samples.
The structured arm advances to one frozen-golden confirmation only if:

- every completion is valid within two calls and at least 95% finish in one;
- exact decision accuracy does not trail treatment on either provider;
- pending-equivalent, newly-delivered/no-response, and visible-no-response
  accuracy does not trail treatment on either provider;
- all emergency cases interrupt, with zero false interrupts; and
- it introduces no critical miss that treatment avoided.

The development corpus has already informed earlier prompt candidates, so a
pass is only a falsification gate, not merge evidence. The unchanged golden
corpus remains the confirmation gate.

## Version 1 result: rejected

Version 1 passed validity, exact aggregate accuracy, waiting, and emergency
checks, but failed two predeclared gates:

- Sonnet finished 24/26 observations in one call (92.3%, below 95%).
- Terra classified both material-change cases and both user-only remediation
  cases as `waiting`, introducing critical misses that treatment avoided.

The relation was emitted only after the model had already decided whether to
write a finding. That allowed it to classify the prior record rather than the
strongest current candidate. The ordinary word `waiting` also admitted an
unintended reading: waiting for a human owner rather than waiting for driver
delivery.

## Version 2 contract and gate

Version 2 makes the candidate explicit before its relation:

```text
CANDIDATE: none|<one concise finding>
RELATION: none|new|covered_no_response|follow_up|resolved
DELIVERY: none|print|queue|steer|interrupt
```

`CANDIDATE` is private observer output unless delivery is routed. A non-`none`
candidate is required even when its relation is `covered_no_response` or
`resolved`; this forces the head to identify what it is classifying.
`covered_no_response` replaces the ambiguous `waiting` label.

Structural consistency is validated as follows:

- `none` requires candidate and delivery `none`;
- `covered_no_response` and `resolved` require a concrete candidate and
  delivery `none`; and
- `new` and `follow_up` require a concrete candidate and routed delivery.

Version 2 gets one fresh two-sample development run and must clear the same
predeclared gate. No further taxonomy or prompt revision is allowed from the
development cases. If it fails, structured classification is rejected.
