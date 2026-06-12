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

Smoke-test delivery with the hidden diagnostic heads (`/hydra-heads test`, `/hydra-heads test-interrupt`); they fire once and revert.

## What's welcome

- New example heads; prototype them as head files (`~/.pi/agent/hydra/`, see [`docs/heads.md`](docs/heads.md)) and PR the ones that prove themselves into [`heads/`](heads)
- Steps toward mid-generation interrupts (see the README's direction section)
- Provider support beyond Anthropic (needs a cache-parity story; read [`docs/architecture.md`](docs/architecture.md) first)
- Replications or extensions of the [`experiments/`](experiments/README.md)

## The bar

Claims about cache behavior must be measured, not assumed. The experiments harness re-verifies every claim against the live API for under a dollar; if your change touches the replay or marker logic, run the re-verification procedure in [`docs/architecture.md`](docs/architecture.md) and put the numbers in the PR. Pure logic goes in `utils.ts` with tests. Match the style of the file you are editing.
