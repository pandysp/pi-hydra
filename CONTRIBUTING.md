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

Smoke-test delivery with the hidden diagnostic heads (`/hydra-heads test`, `/hydra-heads test-interrupt`); they fire once and revert.

## What's welcome

- New example heads; prototype them as head files (`~/.pi/agent/hydra/`, see [`docs/heads.md`](docs/heads.md)) and PR the ones that prove themselves into [`heads/`](heads)
- Steps toward mid-generation interrupts (see "Where this is going" in the README)
- Provider support beyond Anthropic and OpenAI Codex (needs a cache-parity story; read [`docs/architecture.md`](docs/architecture.md) first)
- Replications or extensions of the [`experiments/`](experiments/INDEX.md)

## The bar

Every claim about cache behavior must be backed by a measurement. The cache probes re-verify the mechanism against the live APIs, and a full cache-probe run costs under a dollar. If your change touches the replay or marker logic, run the re-verification procedure in [`docs/architecture.md`](docs/architecture.md) and put the numbers in the PR. Pure logic goes in the matching root module with tests (`protocol.ts`, `delivery.ts`, `utils.ts`). Match the style of the file you are editing.

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
