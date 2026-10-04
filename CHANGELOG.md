# Changelog

## Unreleased

- The main assistant can add a head for a moment without writing a head file: `lifetime: "once"` for one check, or `ends_when` for a head that checks after every response until it reports `done` for that condition and removes itself. See [Heads for a moment](docs/heads.md#heads-for-a-moment). In `pi -p`, a run now waits at its end for the one-off checks it asked for, so the main assistant still gets their feedback. Adding a head is refused while a check under its name is still running or a diagnostic head is active, and going back in the conversation no longer keeps heads from the branch you left ([#54](https://github.com/pandysp/pi-hydra/pull/54)).
- A failed check from a head without tools no longer sends an "automatic notice" to the main assistant, which had nothing to do with it. Hydra still warns you, and `/hydra-stats` now counts failed checks by type.

## 0.1.0

First release on npm: `pi install npm:pi-hydra`. See the [README](README.md) for what Hydra does and what it supports.

- The example `quality` head no longer has `autostart: true`, so a fresh copy of the examples starts no head on its own. Copies you made earlier keep their setting.
