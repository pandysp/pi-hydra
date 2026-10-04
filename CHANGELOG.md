# Changelog

## Unreleased

- A failed check from a head without tools no longer sends an "automatic notice" to the main assistant, which had nothing to do with it. Hydra still warns you, and `/hydra-stats` now counts failed checks by type.

## 0.1.0

First release on npm: `pi install npm:pi-hydra`. See the [README](README.md) for what Hydra does and what it supports.

- The example `quality` head no longer has `autostart: true`, so a fresh copy of the examples starts no head on its own. Copies you made earlier keep their setting.
