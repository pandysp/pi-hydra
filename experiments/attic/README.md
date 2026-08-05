# Attic — superseded probes and one-shot analyses

Files here produced recorded evidence or were one-shot probes whose routes
have moved on. They are out of the working set but intentionally kept
runnable: relative imports were rewritten on move (`./x.mjs` -> `../x.mjs`
for modules that stayed in `experiments/`), their tests still run under
`npm test`, and git history preserves every original path.

Rules:

- Nothing here is imported by the working set, and nothing here is hashed by
  the frozen-input manifests (verified mechanically at move time,
  2026-08-05).
- Asymmetry, stated so it is not read as an accident: attic `*.test.mjs`
  still run under `npm test`, but attic `*.check.mjs` are NOT part of
  `npm run gates` (the gates guard the live dataset and artifacts; archived
  invariants guard retired protocols). If a future dependency migration
  breaks attic tests, excluding `attic/` from vitest is the sanctioned move.
- Results docs and `RUN-LEDGER.md` cite these scripts by their ORIGINAL
  `experiments/<name>.mjs` paths; those citations are historical record and
  stay as written. `git log --follow` connects them.
- New work never imports from the attic. If a file becomes load-bearing
  again, move it back out first.
