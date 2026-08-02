# /code-review max on the golden corpus (2026-08-01)

Andreas ran `/code-review max` against ~/dev/personal/pi-hydra-golden-corpus
(main = pristine seeded codebases; driver-run-scheduler = after a real
19-turn driver run). 15 findings, EVERY ONE with a measured failure
scenario — the strongest ground-truth candidates in the program and the
only source covering all three seeded tasks.

Frozen here because the run wrote only to ~/scratch, which auto-prunes at
14 days.

**Addition 2026-08-02 (GOLDEN-DATASET-V2-SPEC wave 1 Q3):** the verified
runners-up — previously only in the reviewing agent's report and recorded
here as a gap — are now frozen verbatim in `runners-up.json` (13 bullets;
"~14" was an approximation), with transcript provenance inside. They enter
the v2 pool as code-review candidates.

Provenance caveat: on the driver branch the driver's own
docs/scheduling.md enumerates the planted defects, so the two scheduler
findings it names (sweepExpired, claimNext) are VERIFICATION, not
independent discovery — both were measured, not parroted. Everything in
exporter/ and dispatcher/ is clean (byte-identical on both branches,
stub docs), as are the three driver-introduced findings.
