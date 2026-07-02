# Contributing

Issues and PRs are welcome. The codebase is deliberately small: `index.ts` (pi wiring), `utils.ts` (pure logic, tested), `experiments/` (the measurement harness behind every cache claim).

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
npm test         # vitest on the pure helpers
```

Smoke-test delivery with the hidden diagnostic heads (`/hydra-heads test`, `/hydra-heads test-interrupt`); they fire once and revert.

## What's welcome

- New example heads; prototype them as head files (`~/.pi/agent/hydra/`, see [`docs/heads.md`](docs/heads.md)) and PR the ones that prove themselves into [`heads/`](heads)
- Steps toward mid-generation interrupts (see "Where this is going" in the README)
- Provider support beyond Anthropic (needs a cache-parity story; read [`docs/architecture.md`](docs/architecture.md) first)
- Replications or extensions of the [`experiments/`](experiments/README.md)

## The bar

Every claim about cache behavior must be backed by a measurement. The experiments harness re-verifies every claim against the live API, and a full run costs under a dollar. If your change touches the replay or marker logic, run the re-verification procedure in [`docs/architecture.md`](docs/architecture.md) and put the numbers in the PR. Pure logic goes in `utils.ts` with tests. Match the style of the file you are editing.
