# Heads in Flue agents

[Flue](https://flueframework.com/) agents can be reviewed by the same heads as pi. When an agent
is about to finish a response, each head checks it. A finding the agent must act on is added to
the response, so the agent corrects itself before anyone reads its answer.

A check costs little because of how it is built. The head does not read the conversation
afresh: Hydra replays the agent's last request to the provider unchanged, which the provider
serves from its cache, and adds only the agent's last turn and the head's instructions.

## Setup

The adapter lives in [`flue/`](../flue/index.ts) and needs `@flue/runtime` 2.2.2 or later 2.x. Install
pi-hydra into the Flue app, next to Flue and the pi-ai version that Flue release depends on
(0.87.x for Flue 2.2.2), so the adapter uses the app's own Flue:

```bash
npm install github:pandysp/pi-hydra @flue/runtime@2.2.2 @earendil-works/pi-ai@0.87.1
```

A pi-ai version different from Flue's gives the wrapped provider incompatible types.
[`flue/consumer-check.mjs`](../flue/consumer-check.mjs) installs this exact combination into a
fresh app, type-checks it and runs a scripted agent; CI runs it.

```ts
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createFlueHydra } from "pi-hydra/flue";

const hydra = createFlueHydra({ heads: ["/path/to/heads/quality.md"] });

function Reviewer() {
	useModel("anthropic/claude-opus-5-5");
	hydra.useHydra(); // review each response before it settles
	return "You review pull requests.";
}

const flue = await start({ agents: [Reviewer], providers: [hydra.wrap(anthropicProvider())] });
// ... run the agent ...
await flue.stop();
await hydra.close(); // also closes the Codex connections Hydra kept open
```

Three pieces work together:

- `hydra.wrap(provider)` records each request the agent sends. Use the wrapped provider in
  `start({ providers })` or `setProvider()`.
- `hydra.useHydra()` inside the agent function runs the heads when a response is about to settle.
- `createFlueHydra()` installs one Flue instrumentation, which tells Hydra which conversation
  each request belongs to. `close()` removes it.

Options: `heads` (head file paths), `maxRounds` (default 3, below) and `onRecord`, called once per
head check with the conversation, head, round, outcome, findings, any error and the token usage.

## What a check sees

The head receives:

1. the agent's last request to the provider, byte for byte;
2. the agent's last turn after it: its answer and the real results of any tools it called, also
   when a tool ended the run;
3. the head's instructions and the answering rules.

Only requests of the agent's own conversation are recorded. Subagent tasks and scratch prompts
run in conversations of their own, and Flue's compaction requests are excluded by their purpose.

Heads must be judges: `tools: []` in the head file. Heads that use tools are refused when Hydra
is created.

## What happens to findings

| Finding | In Flue |
|---|---|
| `steer` | Added to the response as one `pi-hydra` signal; the agent reads it and keeps working |
| `interrupt` | The same as `steer`: Flue cannot stop a turn in progress without discarding it |
| `print` | Written to the conversation log for the people watching; the agent never sees it |
| none | The response settles |

Heads are told this, instead of pi's behaviour. After the agent's next turn the heads check
again. After `maxRounds` responses with findings, further findings are logged as warnings
marked unresolved and the response settles, rather than running Flue into its own limit of 32
continuations, which fails the response.

A check that fails (provider error, malformed answer, unsupported provider) is logged as a
warning and recorded; the response settles unchanged.

## Providers

Supported: Anthropic Messages and OpenAI Codex. Other provider APIs are reported as failed checks.

For Codex, Hydra runs the agent on pi-ai's `websocket` transport instead of its default `auto`,
and the heads share the agent's provider session. Codex caches by session, and sharing is safe
only while the agent sends its full input every turn, which `auto` does not. This is the one
change Hydra makes to the agent itself. A caller that sets a continuing transport explicitly gets
an error instead. See [Session sharing](providers.md#session-sharing) and
the measured numbers in [Flue adapter](providers.md#flue-adapter).

## Limits

- **Run end only.** Heads check when a response is about to settle, not while it runs. A long
  response is not interrupted mid-way.
- **Advisory, like pi-hydra.** If the process stops while heads are checking, Flue 2.2.2 settles
  the response as successful after restart without running the check again
  ([withastro/flue#810](https://github.com/withastro/flue/issues/810)).
- **Added time.** The response waits for the slowest head before it settles: 1.1–7.1 s per round
  in the measured runs.
- **After compaction** the agent's request starts with a fresh summary, so the first check reads
  less from cache.
- **Claude subscription logins.** Whether a request counts against the plan or is refused as
  third-party use depends on what it contains. Flue requests have been accepted on the plan in
  every test so far; pi's own requests without an extra billing extension were refused.

## Checking it yourself

[`flue/live-check.mjs`](../flue/live-check.mjs) runs an agent whose multiply tool is wrong, with a
head that checks arithmetic, on an existing pi login:

```bash
cd flue && npm ci
node live-check.mjs anthropic   # or codex
```

It asks for 1847 × 2963 and prints the reply, each check and its cache numbers. Passing means
`"correct": true` with one `pi-hydra` signal, unless the model noticed the wrong tool result on its
own.
