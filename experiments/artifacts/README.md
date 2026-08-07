# Frozen artifacts

Each directory is one measured wave: gzipped producer rows and judgments, a
`SHA256SUMS` manifest, and (where the wave produced one) a `verdict.json`.
Contents are IMMUTABLE — a results doc cites them, so rewriting one silently
rewrites the evidence under a published claim. The run ledger
(`../RUN-LEDGER.md`) records what each wave was, what it cost, and which
distillation doc reads it.

Verify everything: `node ../hydra-lab.mjs freeze --verify --all`.

## PROVENANCE — the 2026-08-01 manifest repair

Eight `SHA256SUMS` files under this directory were modified on 2026-08-01 by
the phase-0.5 hardening (`2026-07-24-completion-acting`,
`2026-07-25-tool-free-acting`, `2026-07-31-acting-smoke`,
`2026-07-31-anthropic-cost-sweep`, `2026-07-31-high-screen`,
`2026-07-31-unified-screen`, `2026-07-31-xhigh-screen`,
`2026-08-01-trajectory-pilot`).

**No hash value changed, and none was removed.** Verified set-wise per
directory during the wave-10 adversarial verification: the hash sets are
byte-identical old vs new in seven of the eight; `2026-07-31-unified-screen`
gains exactly one line — `f6d07470… verdict.json`, a file already tracked at
HEAD and previously unhashed. All other edits are path normalization plus a
sort.

Why it was needed: four manifests recorded ABSOLUTE `~/scratch/...` paths.
`~/scratch` auto-prunes at 14 days, so those manifests were on course to
reference files that no longer existed — the evidence would have become
permanently unverifiable around 2026-08-07 while looking fine on disk. The
repair rewrites the recorded paths to the in-repo basenames, so every manifest
now validates against the `.gz` files sitting beside it.

Post-repair state: 83 hashes across 9 directories, 0 mismatches. The `.gz`
payloads themselves were never touched by the repair.
