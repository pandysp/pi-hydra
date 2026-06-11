# Codex Companion Plan: Fork Per Epoch + Persistent State

Status: implemented. Codex v1: `codex-companion.sh` (Apr 2026). Claude Code v2: `mob-observer.sh`.

## Why This Design

The observer must review the current driver session, not drift into its own side conversation.
The cleanest way to guarantee that is to create a fresh fork from the driver for every review epoch.

That creates one problem: a fresh fork forgets practical operational memory.
The fix is to keep that memory in the companion process, not in the forked observer thread.

## Target Behavior

- Every review epoch starts from a fresh fork of the current driver session.
- The fork produces exactly one JSON decision: `noop`, `queue`, or `interrupt`.
- After that decision, the fork is discarded.
- Practical memory survives across epochs and watcher restarts via a local state file.

## Review Lifecycle

1. Capture live driver state:
   - tmux pane excerpt
   - `git status`
   - `git diff --stat`
   - driver busy/idle state

2. Compute a snapshot hash from that observed state.

3. If the snapshot hash has not changed since the last review, skip the epoch.

4. If the snapshot is new, create a fresh hidden Codex fork from the current driver session.

5. Ask the fork for one decision in strict JSON format.

6. Record usage metrics, especially:
   - `input_tokens`
   - `cached_input_tokens`
   - cache hit ratio

7. Apply the decision using persisted local state:
   - `noop`: do nothing
   - `queue`: store one pending message and deliver when the driver is idle
   - `interrupt`: deliver immediately if configured, otherwise queue

8. Discard the fork and wait for the next epoch.

## Persistent State

State will be stored per tmux session in a small local JSON file.

Initial state model:

- `queued_message`
- `queued_reason`
- `cooldown_until`
- `last_review_hash`
- `last_delivered_hash`
- `recent_message_hashes`
- `last_driver_session_id`
- `last_metrics`

## Behavioral Rules

- Observer memory must never live in the forked thread.
- Only one queued message is kept at a time for MVP.
- The companion should not repeat the same advice every epoch.
- Duplicate messages are suppressed by message hashing and cooldowns.
- A watcher restart must not lose queued advice or dedupe state.

## Main Risk

The most likely failure mode is duplicate or stale warnings, because each fresh fork can rediscover the same issue.

Detection:

- run repeated epochs against unchanged state
- confirm only the first warning is queued or delivered
- confirm later identical epochs stay quiet until the cooldown expires or the state changes

## Verification Plan

1. Run in `--delivery print` mode and confirm:
   - a fresh fork is created only for new snapshots
   - unchanged snapshots do not trigger new forks

2. Measure repeated fresh forks from the same driver and log:
   - `input_tokens`
   - `cached_input_tokens`
   - cache hit ratio

3. Run with real tmux delivery and confirm:
   - queued advice flushes when the driver becomes idle
   - interrupt mode still works at least at current prototype level

4. Restart the watcher and confirm:
   - persisted queued state is restored
   - duplicate suppression still works

## Scope For The Next Implementation Pass

- Replace long-lived observer resume logic with one-shot per-epoch forks
- Add persistent local state storage
- Keep existing delivery modes: `queue`, `interrupt`, `print`
- Preserve current tmux-based injection path

## Explicit Non-Goals For The MVP

- multiple queued messages
- advanced prioritization
- perfect interrupt semantics
- cleanup of old fork session files
