# Contributing

Issues and PRs are welcome. The codebase is deliberately small: `index.ts` (pi wiring), `protocol.ts` (the hydra tool's wire contract), `delivery.ts` + `delivery-types.ts` (the delivery ledger and its shapes), `utils.ts` (pure logic, tested), `experiments/` (the measurement harness behind the cache mechanism and the observation-contract research).

## Setup

```bash
git clone https://github.com/pandysp/pi-hydra
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/pi-hydra" ~/.pi/agent/extensions/hydra
cd pi-hydra
npm install      # dev tooling only
```

If you installed hydra via the README quickstart, run `pi remove git:github.com/pandysp/pi-hydra` first; the git package and the symlink are separate load paths, and keeping both loads hydra twice.

Edit, then reload pi (Ctrl-R or `/reload`) to pick up changes. If you move the clone, recreate the symlink: pi skips a dangling extension link silently, and hydra stops existing (no commands, no flags, no observations). Before sending a PR:

```bash
npm run check    # tsc --strict
npm test         # vitest: root modules plus the experiments suite
npm run gates    # experiments invariant gates (CI runs these too)
```

Smoke-test delivery with the hidden diagnostic heads: `/hydra-heads test` forces a `steer`, `/hydra-heads test-interrupt` forces an `interrupt`. They fire once and revert. The revert prevents an infinite loop: a forced interrupt injects a user message, which starts a run, whose run-end observation would otherwise interrupt again.

## What's welcome

- New example heads; prototype them as head files (`~/.pi/agent/hydra/`, see [`docs/heads.md`](docs/heads.md)) and PR the ones that prove themselves into [`heads/`](heads)
- Steps toward mid-generation interrupts (see "Where this is going" in the README)
- Provider support beyond Anthropic and OpenAI Codex (needs a cache-parity story; read [`docs/architecture.md`](docs/architecture.md) first)
- Replications or extensions of the [`experiments/`](experiments/INDEX.md)

## The bar

- Every claim about cache behavior must be backed by a measurement. The cache probes re-verify the mechanism against the live APIs, and a full cache-probe run costs under a dollar.
- If your change touches the replay or marker logic, run the verification procedures in [`docs/architecture.md`](docs/architecture.md) (cache parity, the headless cacheRead check, and the tripwire when transport logic is touched) and put the numbers in the PR.
- Pure logic goes in the matching root module with tests (`protocol.ts`, `delivery.ts`, `utils.ts`).
- Match the style of the file you are editing.

## Working in the research branch

These rules exist because breaking them has real recovery cost; they were
learned the hard way on the `openai-cache-clean` PR:

- **Branch identity:** the PR branch is `openai-cache-clean`. Working
  checkouts may sit on differently named local branches with stale tracking
  upstreams, so `git status -sb` "ahead N" is meaningless there. Sync is
  `git fetch origin openai-cache-clean`, verify your parent is the remote
  tip, then `git push origin HEAD:openai-cache-clean`. Never pull --rebase
  in those checkouts; a non-fast-forward rejection means stop and inspect.
- **Frozen-input manifests:** `experiments/CAPSTONE-FROZEN-INPUTS.json` and
  `experiments/EXPANDED-2Q-FROZEN-INPUTS.json` hash data and code inputs
  byte-for-byte. If you touch a hashed file deliberately, regenerate with
  `npm run manifest:refresh` and `npm run manifest:expanded-2q` in the same
  commit; the tests fail otherwise by design. Prose docs are deliberately
  not hashed.
- **Frozen artifacts are immutable**, including the paired
  `SHA256SUMS` / `SHA256SUMS.gz` manifests — the `.gz` one is plain ASCII
  recording stored-byte hashes, not a compressed duplicate.
- **The dataset version is an identity.** Judged results only pool within
  one `golden-dataset.json` version; a fold bumps the version and every
  consumer must re-run under the new identity. Historical scorers take the
  frozen dataset copy explicitly (`--dataset`).
- **Anthropic OAuth billing** (research transports): replayed captured
  production payloads bill to the plan; fresh-session shapes bill to extra
  usage or are refused. See `DRIVER-PROMPT-REALISM-SPEC.md` for the
  single-variable confirmation.
- **Freezes use `experiments/freeze-lean.mjs`** (tar bundle + per-file
  provenance + the SHA256SUMS pair). The v2-era loose staging is historical.
- **Registration is two-tier.** Anything whose numbers can enter
  `DECISION-TABLE.md` gets the full ceremony: SPEC before data, freeze,
  full ledger row. Probes and one-shot analyses get a minimal
  `RUN-LEDGER.jsonl` row (script, commit, argv, spend) — cheap enough that
  nothing skips the ledger, which is the failure the ceremony exists to
  prevent.

## Growth control

Each rule is tied to a failure this PR actually paid for:

1. Product changes reach `main` only through slice PRs cut from the
   research branch; the research PR itself never merges. (Prevents
   unreviewable 600-file merge units. `pi install git:…` clones the repo —
   main IS the shipped package.)
2. A change to root `*.ts` or product docs on the research branch is
   replayed onto the slice lane before the next frozen run binds it.
   (Prevents silent product drift that later needs archaeology to slice.)
3. A new artifact file enters the repo only if a committed test or manifest
   reads it by path; every other run artifact is ledgered with a
   `mirrorPath` and lives in the mirror. (Prevents the next 360-file
   accretion in the diff.)
4. Never restate a frozen hash or version as a literal in a second file;
   scorers and tests take the dataset and expected version as arguments,
   and the version formula has exactly one implementation
   (`realCatalogVersion`). (Prevents the fold-day red-CI class and the
   diverging-formula red state.)
5. Prose is never hashed into a frozen identity; specs and results change
   without touching any manifest. (Prevents status edits breaking freezes.)
6. The `experiments/` working set stays under ~100 `.mjs` files; the PR
   that retires a route attics its scripts, imports rewritten, tests green.
   (Prevents unbounded flat-directory growth.)
7. Evidence cited by any doc lives in the repo, the mirror, or a freeze
   bundle — never only under `~/scratch`, which auto-prunes after 14 days.
   (Prevents cited evidence silently vanishing.)
8. New model-facing wire formats start in `experiments/` and never enter
   the root modules; `utils.ts` is not a museum. (Prevents retired
   protocols shipping as product code.)
