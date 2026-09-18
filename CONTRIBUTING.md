# Contributing

Issues and PRs are welcome. See the [architecture and module map](docs/architecture.md#module-map) for how the code is organized.

## Setup

```bash
git clone https://github.com/pandysp/pi-hydra
mkdir -p ~/.pi/agent/extensions
ln -sfn "$(pwd)/pi-hydra" ~/.pi/agent/extensions/hydra
cd pi-hydra
npm ci
```

This installs the exact versions in `package-lock.json`, just as the PR check in
[CI](.github/workflows/ci.yml) does. All four Pi development packages are pinned
together. A separate `latest-pi` job tests their `latest` releases daily and on
manual dispatch, so a new Pi release cannot change what an existing PR tests.
Both jobs run the same checks; neither ignores failures. These are a development
baseline and a current-release check, not a promise to support older Pi versions.

To reproduce the latest-Pi check, or deliberately update the development baseline:

```bash
npm ci
npm install --save-dev --save-exact @earendil-works/pi-agent-core@latest \
  @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest \
  @earendil-works/pi-tui@latest
npm ls --depth=0
npm run check
npm test
```

This updates `package.json` and `package-lock.json`. Commit both only when updating
the baseline; use a disposable checkout for a compatibility-only check.

If you installed hydra via the README quickstart, run `pi remove git:github.com/pandysp/pi-hydra` first; the git package and the symlink are separate load paths, and keeping both loads hydra twice.

Edit, then reload pi (Ctrl-R or `/reload`) to pick up changes. If you move the clone, recreate the symlink: pi skips a dangling extension link silently, and hydra stops existing (no commands, no flags, no observations). Before sending a PR:

```bash
npm run check    # tsc, module-state, links, and code-to-doc claims
npm test         # vitest on the root modules
```

Smoke-test delivery with the hidden diagnostic heads: `/hydra-heads test` forces a `steer`, `/hydra-heads test-interrupt` forces an `interrupt`. They fire once and revert. The revert prevents an infinite loop: a forced interrupt injects a user message, which starts a run, whose run-end observation would otherwise interrupt again.

## What's welcome

- New example heads; prototype them as head files (`~/.pi/agent/hydra/`, see [`docs/heads.md`](docs/heads.md)) and PR the ones that prove themselves into [`heads/`](heads)
- Steps toward mid-generation interrupts (see "Where this is going" in the README)
- Provider support beyond Anthropic and OpenAI Codex (needs a cache-parity story; read [`docs/providers.md`](docs/providers.md) first)
- Replications or extensions of the [`experiments/`](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/experiments/INDEX.md)

## The bar

- Every claim about cache behavior must be backed by a measurement. [`docs/providers.md`](docs/providers.md) is the canonical owner of provider behavior, economics, dates, and evidence; other outward docs summarize and link to it.
- If your change touches replay or marker logic, run the procedures in [`docs/providers.md`](docs/providers.md#verification-procedures) (cache parity, the headless cacheRead check, and the tripwire when transport logic is touched) and put the numbers in the PR.
- `npm run check:links` validates local Markdown files and GitHub-compatible heading fragments, including the committed inventory of inbound links discovered outside this repository.
- `npm run check:docs` binds public claims to both narrow code authority regions and canonical documentation sections. If either changes intentionally, review both sides and update only the affected claim explicitly: `npm run update:doc-claims -- --reviewed --claim=<id>`.
- Keep pure logic in its matching root module and test it there.
- Match the style of the file you are editing.

## Branches and research

Start product changes from `main` and open PRs against `main`. Keep each PR
focused: `pi install git:…` installs this branch, so users get what is on it.

Research lives on `openai-cache-clean`. Bring individual product changes into
separate PRs from `main`; never merge the whole research branch. See its
[research workflow](https://github.com/pandysp/pi-hydra/blob/openai-cache-clean/CONTRIBUTING.md#working-in-the-research-branch)
for research-specific instructions.

## Keep the shipped package small

- Keep experiments and retired code out of the shipped root modules.
- Commit generated files only when a test or manifest uses them; keep other
  research outputs in the research archive.
- Save evidence linked from docs in the repository or research archive,
  not just in scratch folders that will be deleted.
