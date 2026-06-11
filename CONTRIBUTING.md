# Contributing

Issues and PRs are welcome. The codebase is deliberately small: `index.ts` (pi wiring), `utils.ts` (pure logic, tested), `experiments/` (the measurement harness behind every cache claim).

## Setup

```bash
git clone https://github.com/pandysp/pi-hydra
ln -s "$(pwd)/pi-hydra" ~/.pi/agent/extensions/hydra
cd pi-hydra
npm install      # dev tooling only
```

Edit, then reload pi (Ctrl-R or `/reload`) to pick up changes. Before sending a PR:

```bash
npm run check    # tsc --strict
npm test         # vitest on the pure helpers
```

Smoke-test delivery with the hidden diagnostic lenses (`/hydra-lens test`, `/hydra-lens test-interrupt`); they fire once and revert.

## What's welcome

- New built-in lenses; prototype them first as custom lens files (`~/.pi/agent/hydra/lenses/`, see [`docs/lenses.md`](docs/lenses.md)) and PR the ones that prove themselves
- Steps toward async heads and the self-tuning loop (see the README's direction section and issue #5)
- Provider support beyond Anthropic (needs a cache-parity story; read [`docs/architecture.md`](docs/architecture.md) first)
- Replications or extensions of the [`experiments/`](experiments/README.md)

## The bar

Claims about cache behavior must be measured, not assumed. The experiments harness re-verifies every claim against the live API for under a dollar; if your change touches the replay or marker logic, run the re-verification procedure in [`docs/architecture.md`](docs/architecture.md) and put the numbers in the PR. Pure logic goes in `utils.ts` with tests. Match the style of the file you are editing.
