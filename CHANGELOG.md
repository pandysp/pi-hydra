# Changelog

## Unreleased

- A head that lists a tool the main assistant doesn't have no longer runs and quietly fails: Hydra turns it off, or refuses to add it, with a warning naming the missing tools and the fix. pi turns `grep`, `find` and `ls` off by default, so a head with `tools: read, grep` now needs `"+grep"` in `defaultTools`. See [Tools](docs/heads.md#tools).
- When a head's file disappears while it is active, Hydra now tells the main assistant with a note instead of a steer, so the notice no longer wakes an idle main assistant.
- Hydra no longer warns about unsupported tools in head files that aren't on; it blocks such a head when it is turned on.
- The example `tuner` head no longer lists `ls`, which pi turns off by default. A copy you made earlier still lists it, so Hydra now turns it off; remove `ls` from its `tools:` line, or add `"+ls"` to `defaultTools`.
- The `hydra` tool now says that a head without a tool list gets the main assistant's tools, not all tools.
- `/hydra-heads` marks a head that can use tools with `tools` instead of `acting`.

## 0.1.1

- The main assistant can add a head for a moment without writing a head file: `lifetime: "once"` for one check, or `ends_when` for a head that checks after every response until it reports `done` for that condition and removes itself. See [Heads for a moment](docs/heads.md#heads-for-a-moment). In `pi -p`, a run now waits at its end for the one-off checks it asked for, so the main assistant still gets their feedback. Adding a head is refused while a check under its name is still running or a diagnostic head is active, and going back in the conversation no longer keeps heads from the branch you left ([#54](https://github.com/pandysp/pi-hydra/pull/54)).
- A failed check from a head without tools no longer sends an "automatic notice" to the main assistant, which had nothing to do with it. Hydra still warns you, and `/hydra-stats` now counts failed checks by type.

## 0.1.0

First release on npm: `pi install npm:pi-hydra`. See the [README](README.md) for what Hydra does and what it supports.

- The example `quality` head no longer has `autostart: true`, so a fresh copy of the examples starts no head on its own. Copies you made earlier keep their setting.
