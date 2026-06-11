#!/usr/bin/env bash
# Minimal cache hit test: two consecutive forks of the same session
# If cache works, fork2 should read from cache written by fork1
# Run from the project directory where the session was created (--resume
# resolves conversation JSONL relative to cwd).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_JS="$HOME/.mob-observer/node_modules/@anthropic-ai/claude-code/cli.js"
PRELOAD="$SCRIPT_DIR/andon-cache-fix.mjs"
SESSION_ID="${1:?Usage: $0 <session-id>}"

echo "=== Fork 1 (creates cache) ==="
NODE_OPTIONS="--import $PRELOAD" ANDON_DUMP_PATH=/tmp/andon-fork1.json \
  node "$CLI_JS" \
    --resume "$SESSION_ID" --fork-session --print \
    --no-session-persistence --output-format json \
    -p "Reply with exactly: PING" 2>/dev/null | jq '{input_tokens: .usage.input_tokens, cache_read: .usage.cache_read_input_tokens, cache_create: .usage.cache_creation_input_tokens}'

echo ""
echo "=== Fork 2 (should hit cache) ==="
NODE_OPTIONS="--import $PRELOAD" ANDON_DUMP_PATH=/tmp/andon-fork2.json \
  node "$CLI_JS" \
    --resume "$SESSION_ID" --fork-session --print \
    --no-session-persistence --output-format json \
    -p "Reply with exactly: PONG" 2>/dev/null | jq '{input_tokens: .usage.input_tokens, cache_read: .usage.cache_read_input_tokens, cache_create: .usage.cache_creation_input_tokens}'

echo ""
echo "=== Prefix diff (should be empty if cache-safe) ==="
# Compare everything except the last message (the -p prompt which intentionally differs)
jq -S 'del(.messages[-1])' /tmp/andon-fork1.json > /tmp/andon-fork1-prefix.json
jq -S 'del(.messages[-1])' /tmp/andon-fork2.json > /tmp/andon-fork2-prefix.json
diff /tmp/andon-fork1-prefix.json /tmp/andon-fork2-prefix.json && echo "IDENTICAL — cache should hit" || echo "DIVERGENT — see diff above"
