# Contributing

Issues and pull requests are welcome. [VISION.md](VISION.md) says what fits the project, and the [module map](docs/architecture.md#module-map) how the code is organized. If you use an agent, start it in the repository so it loads [AGENTS.md](AGENTS.md).

## Setup

```bash
git clone https://github.com/pandysp/pi-hydra
cd pi-hydra
npm ci
pi install "$(pwd)"
```

If Hydra is already installed, remove that copy first (`pi remove npm:pi-hydra`, `pi remove git:github.com/pandysp/pi-hydra`, or a link in `~/.pi/agent/extensions/`). Otherwise Pi loads Hydra twice.

After an edit, run `/reload` in Pi. If you move the clone, run `pi install` again at its new place and `pi remove` the old path. Pi skips a path that no longer exists without a warning, and Hydra then has no commands, flags or checks.

To try message delivery, run `/hydra-heads test`. A hidden test head sends one `steer` and then turns itself off.

`npm ci` installs the Pi versions pinned in `package-lock.json`, the same ones CI tests pull requests with, so a new Pi release does not change what a pull request is tested against. A separate `latest-pi` job in [CI](.github/workflows/ci.yml) tests the newest Pi every day. Neither is a promise to support older Pi versions. To test the newest Pi locally or to move the pin:

```bash
npm install --save-dev --save-exact @earendil-works/pi-agent-core@latest \
  @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest \
  @earendil-works/pi-tui@latest
npm run check && npm test
```

Commit the changed `package.json` and `package-lock.json` only when you move the pin. For a test only, use a throwaway clone.

## Before a pull request

```bash
npm run check    # types, module state, links, doc claims
npm test
```

- Back every claim about cache behavior with a measurement in [`docs/providers.md`](docs/providers.md): the date, model, setup and numbers. Don't commit raw data or measurement scripts; the numbers in the docs are the record.
- If you change how Hydra replays requests or places cache markers, run the [verification procedures](docs/providers.md#verification-procedures) and put the numbers in the pull request.
- If `npm run check` reports a doc claim, review the code and the doc section it ties together, then update only that claim: `npm run update:doc-claims -- --reviewed --claim=<id>`.
- Every option Hydra passes to Pi's agent loop or session needs a test that shows its effect in a real loop. Pi ignores option names it does not know, so a renamed option fails without an error.
- If you change what heads send to the main assistant, also run a live session with a real model, in a session you can stop, and read how the main assistant takes the messages. Tests cannot show a head that wakes the assistant on every check, or an assistant that takes a head's message for the user's words.
- To run Pi with the Hydra of the clone or worktree you are in, use `npm run pi` (arguments for Pi go after `--`). It starts Pi in a throwaway folder with this copy of Hydra in place of the installed one and all your other extensions. Don't use `-ne` for this: it also turns off your other extensions, and the errors that follow can point elsewhere.
- A change users notice gets an entry under `Unreleased` in [`CHANGELOG.md`](CHANGELOG.md), in the same pull request.
- Keep pure logic in its matching root module and test it there.
- Match the style of the file you edit.

[flue-hydra](README.md#flue-agents) uses `utils.ts`, `judge.ts` and `delivery.ts` from a pinned commit of this repository. If you change what they export or how heads are prompted, flue-hydra gets the change when it next moves its pin.

## What's welcome

- Changes that make heads catch more or cost less, with a measurement that shows it.
- Removing code, options and routes nobody needs.
- New providers and agent hosts, once their cache behavior is measured ([VISION.md](VISION.md#out-of-scope)).
- Better control over when heads run and when they stop, like one-off heads and heads that end themselves.
- Plainer wording in docs, code comments and head instructions.
- Example heads that proved themselves as head files ([`docs/heads.md`](docs/heads.md)), for [`heads/`](heads).

The [open issues](https://github.com/pandysp/pi-hydra/issues) list concrete ideas.

## Branches

Start from `main` and open pull requests against it. Keep each one focused: `main` is what the next release publishes, and `pi install git:…` installs it directly.

You don't need the `openai-cache-clean` branch. It holds earlier research and its evidence, and is never merged.

## Keep the npm package small

- Every root `.ts` file except tests ships to npm (`files` in `package.json`), so keep experiments and retired code out of them.
- Commit generated files only when a test or manifest uses them.

## Releasing

Pushing a `v<version>` tag makes GitHub Actions publish to npm, with a provenance record and no token.

1. Move the `Unreleased` entries in `CHANGELOG.md` under the new version, set the same version in `package.json`, and merge that to `main`.
2. Tag the merge commit and push the tag: `git tag v<version> && git push origin v<version>`.
3. The `publish` job checks that the tag matches `package.json`, runs the checks and tests, and publishes. `npm view pi-hydra _npmUser` should then name GitHub Actions.
