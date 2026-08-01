# /code-review max on the golden corpus (2026-08-01)

Andreas ran `/code-review max` against ~/dev/personal/pi-hydra-golden-corpus
(main = pristine seeded codebases; driver-run-scheduler = after a real
19-turn driver run). 15 findings, EVERY ONE with a measured failure
scenario — the strongest ground-truth candidates in the program and the
only source covering all three seeded tasks.

Frozen here because the run wrote only to ~/scratch, which auto-prunes at
14 days. The ~14 verified runners-up live in the agent's report, not in
this JSON — a documented gap for golden-set v2.

Provenance caveat: on the driver branch the driver's own
docs/scheduling.md enumerates the planted defects, so the two scheduler
findings it names (sweepExpired, claimNext) are VERIFICATION, not
independent discovery — both were measured, not parroted. Everything in
exporter/ and dispatcher/ is clean (byte-identical on both branches,
stub docs), as are the three driver-introduced findings.
