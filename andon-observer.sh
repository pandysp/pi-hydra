#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKDIR="$(pwd)"

# --- Claude Code integration ---
CLI_JS="$HOME/.andon-observer/node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs"
PRELOAD="$SCRIPT_DIR/andon-cache-fix.mjs"
SESSIONS_DIR="$HOME/.claude/sessions"

# --- defaults ---
LENS="quality"
DELIVERY_MODE="queue"
POLL_INTERVAL=4
COOLDOWN_SECONDS=0
FULL_ACCESS=false
BRIDGE_SESSION_ID=""
TMUX_SESSION=""

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/andon-observer"
RECENT_HASH_LIMIT=20

STATE_QUEUED_MESSAGE=""
STATE_QUEUED_REASON=""
STATE_QUEUED_HASH=""
STATE_COOLDOWN_UNTIL=0
STATE_LAST_REVIEW_HASH=""
STATE_LAST_DELIVERED_HASH=""
STATE_LAST_DRIVER_SESSION_ID=""
STATE_LAST_INPUT_TOKENS=0
STATE_LAST_CACHE_READ_TOKENS=0
STATE_LAST_CACHE_CREATION_TOKENS=0
STATE_LAST_CACHE_HIT_RATIO=0
declare -a STATE_RECENT_MESSAGE_HASHES=()
RECENT_DECISIONS_LIMIT=3
STATE_RECENT_DECISIONS="[]"

# --- lens prompts ---
declare -A LENS_PROMPTS=(
  ["quality"]="Review through a QUALITY lens. Focus on correctness risks, missing verification, dangerous assumptions, obvious regressions, and code that looks likely to break. Do not nitpick style."
  ["security"]="Review through a SECURITY lens. Focus on auth, authorization, secret handling, injection risk, unsafe shelling-out, data exposure, and trust boundaries. Do not comment on style or product scope."
  ["simplifier"]="Review through a SIMPLIFIER lens. Focus on unnecessary complexity, abstractions that do not earn their keep, code that could be deleted, and over-built solutions. Do not comment on unrelated bugs or security."
  ["api-design"]="Review through an API DESIGN lens. Focus on contract clarity, compatibility, consistency, error shapes, naming, and ergonomics. Do not comment on internal code structure."
)

# =============================================================================
# Utilities
# =============================================================================

log() {
  printf "[andon-observer %s] %s\n" "$(date +%H:%M:%S)" "$*" >&2
}

usage() {
  cat <<'EOF'
Usage:
  ./andon-observer.sh <tmux-session> <bridge-session-id> [options]

Arguments:
  tmux-session               Name of the tmux session running Claude Code
  bridge-session-id          Bridge session ID from Claude Code greeting
                             (e.g. session_01BEJEX6VP6NVN6xPDzaRzBa)

Options:
  --lens NAME                  quality | security | simplifier | api-design
  --delivery MODE              queue | interrupt | print
  --poll-interval SECONDS      Default: 4
  --cooldown-seconds N         Default: 90
  --full-access                Give observer full tool access (read files, run commands)

Notes:
  - The bridge session ID is shown in Claude Code's greeting line:
    "Code in CLI or at https://claude.ai/code/session_XXXXX"
  - Runs continuously until the driver session exits or Ctrl-C.
  - Each review forks the driver's session headlessly via --print.
  - Model and effort level are inherited from the driver session via --resume.
    Overriding either would break prompt cache sharing.
  - The observer will wait for the session to become active (first message sent).
  - Queue, cooldown, and dedupe state live in a persisted local state file.
  - queue mode is the safe default. interrupt mode is experimental.
EOF
}

# =============================================================================
# CLI argument parsing
# =============================================================================

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lens)
      LENS="${2:?missing lens}"
      shift 2
      ;;
    --delivery)
      DELIVERY_MODE="${2:?missing delivery mode}"
      shift 2
      ;;
    --poll-interval)
      POLL_INTERVAL="${2:?missing seconds}"
      shift 2
      ;;
    --cooldown-seconds)
      COOLDOWN_SECONDS="${2:?missing cooldown}"
      shift 2
      ;;
    --full-access)
      FULL_ACCESS=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$TMUX_SESSION" ]]; then
        TMUX_SESSION="$1"
      elif [[ -z "$BRIDGE_SESSION_ID" ]]; then
        BRIDGE_SESSION_ID="$1"
      else
        echo "Unexpected argument: $1" >&2
        usage
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$TMUX_SESSION" || -z "$BRIDGE_SESSION_ID" ]]; then
  echo "Error: both <tmux-session> and <bridge-session-id> are required" >&2
  usage
  exit 1
fi

if [[ ! "$BRIDGE_SESSION_ID" =~ ^session_ ]]; then
  echo "Error: bridge-session-id must start with 'session_' (got: $BRIDGE_SESSION_ID)" >&2
  echo "Copy it from Claude Code's greeting: \"Code in CLI or at https://claude.ai/code/session_XXXXX\"" >&2
  exit 1
fi

if [[ -z "${LENS_PROMPTS[$LENS]:-}" ]]; then
  echo "Unknown lens: $LENS" >&2
  exit 1
fi

# Validate prerequisites
if [[ ! -f "$CLI_JS" ]]; then
  echo "Claude Code CLI not found at $CLI_JS" >&2
  echo "Install: mkdir -p ~/.andon-observer && cd ~/.andon-observer && pnpm init && pnpm add @anthropic-ai/claude-code" >&2
  exit 1
fi

if [[ ! -f "$PRELOAD" ]]; then
  echo "Cache fix preload not found at $PRELOAD" >&2
  exit 1
fi

DRIVER_PANE="${TMUX_SESSION}:0.0"
WORKDIR_HASH="$(printf '%s' "$WORKDIR" | shasum -a 256 | awk '{print $1}' | cut -c1-12)"
SESSION_SLUG="$(printf '%s' "$TMUX_SESSION" | tr -cs 'A-Za-z0-9._-' '_')"
STATE_FILE="$STATE_DIR/${SESSION_SLUG}-${WORKDIR_HASH}.json"

# =============================================================================
# Core helpers
# =============================================================================

require_tmux_session() {
  if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "tmux session '$TMUX_SESSION' not found" >&2
    exit 1
  fi
}

hash_text() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

cache_hit_ratio() {
  local cache_read="$1"
  local cache_create="$2"
  local input="$3"
  awk -v read="$cache_read" -v create="$cache_create" -v input="$input" 'BEGIN {
    total = read + create + input
    if (total > 0) {
      printf "%.4f", read / total
    } else {
      printf "0"
    }
  }'
}

# =============================================================================
# State management
# =============================================================================

ensure_state_file() {
  if [[ -f "$STATE_FILE" ]]; then
    return 0
  fi

  mkdir -p "$STATE_DIR"
  local tmp_file
  tmp_file="$(mktemp -t andon-observer-state)"
  cat >"$tmp_file" <<'EOF'
{"queued_message":"","queued_reason":"","queued_hash":"","cooldown_until":0,"last_review_hash":"","last_delivered_hash":"","recent_message_hashes":[],"last_driver_session_id":"","last_metrics":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_hit_ratio":0}}
EOF
  mv "$tmp_file" "$STATE_FILE"
}

load_state() {
  ensure_state_file

  STATE_QUEUED_MESSAGE="$(jq -r '.queued_message // ""' "$STATE_FILE")"
  STATE_QUEUED_REASON="$(jq -r '.queued_reason // ""' "$STATE_FILE")"
  STATE_QUEUED_HASH="$(jq -r '.queued_hash // ""' "$STATE_FILE")"
  STATE_COOLDOWN_UNTIL="$(jq -r '.cooldown_until // 0' "$STATE_FILE")"
  STATE_LAST_REVIEW_HASH="$(jq -r '.last_review_hash // ""' "$STATE_FILE")"
  STATE_LAST_DELIVERED_HASH="$(jq -r '.last_delivered_hash // ""' "$STATE_FILE")"
  STATE_LAST_DRIVER_SESSION_ID="$(jq -r '.last_driver_session_id // ""' "$STATE_FILE")"
  STATE_LAST_INPUT_TOKENS="$(jq -r '.last_metrics.input_tokens // 0' "$STATE_FILE")"
  STATE_LAST_CACHE_READ_TOKENS="$(jq -r '.last_metrics.cache_read_input_tokens // 0' "$STATE_FILE")"
  STATE_LAST_CACHE_CREATION_TOKENS="$(jq -r '.last_metrics.cache_creation_input_tokens // 0' "$STATE_FILE")"
  STATE_LAST_CACHE_HIT_RATIO="$(jq -r '.last_metrics.cache_hit_ratio // 0' "$STATE_FILE")"
  mapfile -t STATE_RECENT_MESSAGE_HASHES < <(jq -r '.recent_message_hashes[]?' "$STATE_FILE")
  STATE_RECENT_DECISIONS="$(jq -c '.recent_decisions // []' "$STATE_FILE")"
}

save_state() {
  mkdir -p "$STATE_DIR"

  local recent_json metrics_json tmp_file
  recent_json="$(printf '%s\n' "${STATE_RECENT_MESSAGE_HASHES[@]-}" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  metrics_json="$(
    jq -n \
      --argjson input "$STATE_LAST_INPUT_TOKENS" \
      --argjson cache_read "$STATE_LAST_CACHE_READ_TOKENS" \
      --argjson cache_create "$STATE_LAST_CACHE_CREATION_TOKENS" \
      --argjson ratio "$STATE_LAST_CACHE_HIT_RATIO" \
      '{input_tokens:$input, cache_read_input_tokens:$cache_read, cache_creation_input_tokens:$cache_create, cache_hit_ratio:$ratio}'
  )"
  tmp_file="$(mktemp -t andon-observer-state)"
  jq -n \
    --arg queued_message "$STATE_QUEUED_MESSAGE" \
    --arg queued_reason "$STATE_QUEUED_REASON" \
    --arg queued_hash "$STATE_QUEUED_HASH" \
    --arg last_review_hash "$STATE_LAST_REVIEW_HASH" \
    --arg last_delivered_hash "$STATE_LAST_DELIVERED_HASH" \
    --arg last_driver_session_id "$STATE_LAST_DRIVER_SESSION_ID" \
    --argjson cooldown_until "$STATE_COOLDOWN_UNTIL" \
    --argjson recent_message_hashes "$recent_json" \
    --argjson last_metrics "$metrics_json" \
    --argjson recent_decisions "$STATE_RECENT_DECISIONS" \
    '{
      queued_message: $queued_message,
      queued_reason: $queued_reason,
      queued_hash: $queued_hash,
      cooldown_until: $cooldown_until,
      last_review_hash: $last_review_hash,
      last_delivered_hash: $last_delivered_hash,
      recent_message_hashes: $recent_message_hashes,
      last_driver_session_id: $last_driver_session_id,
      last_metrics: $last_metrics,
      recent_decisions: $recent_decisions
    }' >"$tmp_file"
  mv "$tmp_file" "$STATE_FILE"
}

# =============================================================================
# Dedup / cooldown
# =============================================================================

recent_hash_seen() {
  local target_hash="$1"
  local hash_value
  for hash_value in "${STATE_RECENT_MESSAGE_HASHES[@]}"; do
    if [[ "$hash_value" == "$target_hash" ]]; then
      return 0
    fi
  done
  return 1
}

add_recent_hash() {
  local target_hash="$1"
  local -a next_hashes=()
  local hash_value

  [[ -n "$target_hash" ]] || return 0

  next_hashes+=("$target_hash")
  for hash_value in "${STATE_RECENT_MESSAGE_HASHES[@]}"; do
    [[ -n "$hash_value" ]] || continue
    [[ "$hash_value" == "$target_hash" ]] && continue
    next_hashes+=("$hash_value")
    if (( ${#next_hashes[@]} >= RECENT_HASH_LIMIT )); then
      break
    fi
  done

  STATE_RECENT_MESSAGE_HASHES=("${next_hashes[@]}")
}

set_last_metrics() {
  local input_tokens="$1"
  local cache_read="$2"
  local cache_create="$3"

  STATE_LAST_INPUT_TOKENS="$input_tokens"
  STATE_LAST_CACHE_READ_TOKENS="$cache_read"
  STATE_LAST_CACHE_CREATION_TOKENS="$cache_create"
  STATE_LAST_CACHE_HIT_RATIO="$(cache_hit_ratio "$cache_read" "$cache_create" "$input_tokens")"
}

clear_queued_message() {
  STATE_QUEUED_MESSAGE=""
  STATE_QUEUED_REASON=""
  STATE_QUEUED_HASH=""
}

queue_message() {
  local message="$1"
  local reason="$2"
  local message_hash="$3"

  STATE_QUEUED_MESSAGE="$message"
  STATE_QUEUED_REASON="$reason"
  STATE_QUEUED_HASH="$message_hash"
  add_recent_hash "$message_hash"
}

record_decision() {
  local action="$1"
  local reason="$2"
  local message="$3"
  STATE_RECENT_DECISIONS="$(
    jq -c --arg a "$action" --arg r "$reason" --arg m "$message" \
      --argjson limit "$RECENT_DECISIONS_LIMIT" \
      '[{action:$a, reason:$r, message:$m}] + . | .[:$limit]' <<<"$STATE_RECENT_DECISIONS"
  )"
}

mark_delivered() {
  local message_hash="$1"

  STATE_LAST_DELIVERED_HASH="$message_hash"
  STATE_COOLDOWN_UNTIL="$(( $(date +%s) + COOLDOWN_SECONDS ))"
  add_recent_hash "$message_hash"
  clear_queued_message
}

# =============================================================================
# Driver session discovery (Claude Code)
# =============================================================================

# Resolve a bridge session ID (session_XXXXX) to the internal sessionId UUID.
# Scans ~/.claude/sessions/*.json for a matching bridgeSessionId field.
# Returns the sessionId and sets DRIVER_PID as a side effect.
DRIVER_PID=""
resolve_bridge_session_id() {
  local bridge_id="$1"
  local file bid sid pid

  for file in "$SESSIONS_DIR"/*.json; do
    [[ -f "$file" ]] || continue

    bid="$(jq -r '.bridgeSessionId // ""' "$file" 2>/dev/null)" || continue
    [[ "$bid" == "$bridge_id" ]] || continue

    sid="$(jq -r '.sessionId // ""' "$file" 2>/dev/null)" || continue
    pid="$(jq -r '.pid // ""' "$file" 2>/dev/null)" || continue

    [[ -n "$sid" ]] || continue

    # PID must be alive
    kill -0 "$pid" 2>/dev/null || continue

    DRIVER_PID="$pid"
    printf '%s\n' "$sid"
    return 0
  done

  return 1
}

wait_for_driver_session_id() {
  log "Resolving bridge session $BRIDGE_SESSION_ID"
  local sid=""
  local tries=0

  while true; do
    if sid="$(resolve_bridge_session_id "$BRIDGE_SESSION_ID")"; then
      printf '%s\n' "$sid"
      return 0
    fi
    sleep 2
    tries=$((tries + 1))
    if (( tries == 1 )); then
      log "Waiting for driver session to become active (send first message in Claude Code)"
    elif (( tries % 10 == 0 )); then
      log "Still waiting for bridge session $BRIDGE_SESSION_ID ..."
    fi
  done
}

# =============================================================================
# Driver pane inspection
# =============================================================================

driver_capture() {
  # Capture last 20 lines — only used for busy/idle detection, not for context.
  tmux capture-pane -t "$DRIVER_PANE" -p -S -20 2>/dev/null || true
}

driver_is_busy() {
  driver_capture | grep -Eq 'esc to interrupt|Working \([0-9]+s'
}

driver_accepting_injection() {
  local pane_text
  pane_text="$(driver_capture)"
  # Not busy AND showing the Claude Code input prompt.
  # U+276F (❯) is the heavy right-pointing angle quotation mark used by Claude Code.
  # We also check for "Use /skills" as a fallback prompt indicator.
  ! grep -Eq 'esc to interrupt|Working \([0-9]+s' <<<"$pane_text" &&
    grep -qE '❯|Use /skills' <<<"$pane_text"
}

# =============================================================================
# Observer prompt construction (/btw-style framing)
# =============================================================================

build_observer_prompt() {
  local driver_busy="$1"
  local queued_pending="$2"
  local recent_decisions_text=""

  # Format recent decisions for the prompt (most recent first)
  if [[ "$STATE_RECENT_DECISIONS" != "[]" ]]; then
    recent_decisions_text="$(
      echo "Your recent reviews (most recent first):"
      jq -r '.[] | "- \(.action): \(.reason)\(.message | if . != "" then " → \"\(.)" else "" end)"' <<<"$STATE_RECENT_DECISIONS"
      echo "Do NOT repeat the same feedback. Only flag NEW issues or escalate if the driver ignored prior feedback."
    )"
  fi

  cat <<EOF
<system-reminder>This is an observer review. You must respond with a single JSON object only.

IMPORTANT CONTEXT:
- You are a separate, lightweight observer spawned to review the driver's work
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
$(if [[ "$FULL_ACCESS" == true ]]; then
cat <<'TOOLS'
- You have full tool access. You MAY read files, grep, or run commands to verify your review — but keep it brief and focused on your lens.
- Do NOT write files, edit code, or make changes. You are a reviewer, not a contributor.
TOOLS
else
cat <<'TOOLS'
- You are in read-only observer mode. Tool calls are BLOCKED and will fail with a permission error. Do not attempt them — they waste tokens and produce no useful output.
- Review from conversation context ONLY. Do not try to read files, run commands, search, or take any actions.
TOOLS
fi)
- This is a one-off response — there will be no follow-up turns
- NEVER say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action
- If you cannot evaluate from the conversation context alone, say so

LENS: ${LENS_PROMPTS[$LENS]}

The driver is currently ${driver_busy:+busy (mid-turn)}${driver_busy:-idle}.
${queued_pending:+A previous observer message is queued for delivery.}
${recent_decisions_text}

Return JSON only. No markdown fences. Use this exact shape:
{"action":"noop|queue|interrupt","reason":"short reason","message":"short message or empty"}

Rules:
- action=noop when nothing warrants feedback from your lens.
- action=queue when feedback is useful but can wait.
- action=interrupt only for high-confidence issues that should preempt the driver now.
- message must be empty string for noop.
- message must be one short paragraph, under 240 characters.
- message must NOT start with "[quality]" or any lens prefix - the system adds that automatically.
- reason must stay under 120 characters.</system-reminder>
EOF
}

# =============================================================================
# Observer fork execution (headless via --print)
# =============================================================================

run_observer_epoch() {
  local driver_sid="$1"
  local driver_busy="$2"
  local queued_pending="$3"
  local prompt raw_output result_text
  local input_tokens cache_read cache_create ratio

  prompt="$(build_observer_prompt "$driver_busy" "$queued_pending")"

  log "Running observer fork from driver $driver_sid"

  # Run Claude Code headlessly via node + preload.
  # --resume + --fork-session: inherit driver's full conversation context
  # --print: headless mode, exit after response
  # --no-session-persistence: don't save fork to sessions directory
  # --output-format json: structured output with usage stats
  # -p: the observer prompt
  #
  # Model is inherited from the driver session via --resume. Overriding would
  # break prompt cache sharing. Effort level is also inherited for the same reason.
  local stderr_file
  stderr_file="$(mktemp -t andon-observer-stderr)"
  local full_access_flags=""
  if [[ "$FULL_ACCESS" == true ]]; then
    full_access_flags="--dangerously-skip-permissions"
  fi
  if ! raw_output="$(
    NODE_OPTIONS="--import $PRELOAD" \
    node "$CLI_JS" \
      --resume "$driver_sid" \
      --fork-session \
      --print \
      --no-session-persistence \
      --output-format json \
      $full_access_flags \
      -p "$prompt" 2>"$stderr_file"
  )"; then
    log "Observer fork command failed"
    if [[ -s "$stderr_file" ]]; then
      log "stderr: $(head -c 500 "$stderr_file")"
    fi
    rm -f "$stderr_file"
    return 1
  fi
  rm -f "$stderr_file"

  # Validate we got JSON output
  if ! jq -e . >/dev/null 2>&1 <<<"$raw_output"; then
    log "Observer fork returned non-JSON output"
    log "Raw output (first 200 chars): $(head -c 200 <<<"$raw_output")"
    return 1
  fi

  # Extract the model's text response from .result
  result_text="$(jq -r '.result // ""' <<<"$raw_output" 2>/dev/null)"

  # Strip markdown code fences if the model wrapped its JSON
  result_text="$(sed -e '1{/^```json$/d;}' -e '1{/^```$/d;}' -e '${/^```$/d;}' <<<"$result_text")"

  # Robustly extract JSON from potentially conversational responses.
  # The model sometimes returns prose with embedded JSON, especially with large contexts.
  if ! jq -e . >/dev/null 2>&1 <<<"$result_text"; then
    local extracted_json
    # Try to find a JSON object with our expected fields
    extracted_json="$(grep -oE '\{[^{}]*"action"[^{}]*\}' <<<"$result_text" | head -1)" || true
    if [[ -n "$extracted_json" ]] && jq -e . >/dev/null 2>&1 <<<"$extracted_json"; then
      log "Extracted JSON from conversational response"
      result_text="$extracted_json"
    else
      log "WARN: No valid JSON found in observer response, treating as noop"
      log "Raw result (first 200 chars): $(head -c 200 <<<"$result_text")"
      result_text='{"action":"noop","reason":"unparseable response","message":""}'
    fi
  fi

  # Extract usage metrics for cache health monitoring
  input_tokens="$(jq -r '.usage.input_tokens // 0' <<<"$raw_output" 2>/dev/null || printf '0')"
  cache_read="$(jq -r '.usage.cache_read_input_tokens // 0' <<<"$raw_output" 2>/dev/null || printf '0')"
  cache_create="$(jq -r '.usage.cache_creation_input_tokens // 0' <<<"$raw_output" 2>/dev/null || printf '0')"

  ratio="$(cache_hit_ratio "$cache_read" "$cache_create" "$input_tokens")"
  set_last_metrics "$input_tokens" "$cache_read" "$cache_create"
  save_state
  log "Epoch tokens: input=$input_tokens cache_read=$cache_read cache_create=$cache_create hit=${ratio}"

  printf '%s\n' "$result_text"
}

# =============================================================================
# Decision handling
# =============================================================================

decision_field() {
  local text="$1"
  local field="$2"
  jq -r ".$field // empty" <<<"$text" 2>/dev/null || true
}

# =============================================================================
# tmux delivery
# =============================================================================

deliver_to_driver() {
  local message="$1"
  [[ -n "$message" ]] || return 0

  log "Injecting into driver"
  tmux send-keys -t "$DRIVER_PANE" -l "$message"
  sleep 0.20
  tmux send-keys -t "$DRIVER_PANE" Enter
  sleep 0.35
  tmux send-keys -t "$DRIVER_PANE" Enter
}

interrupt_and_deliver() {
  local message="$1"
  log "Experimental interrupt delivery"
  tmux send-keys -t "$DRIVER_PANE" Escape
  sleep 0.40
  deliver_to_driver "$message"
}

flush_queued_message_if_possible() {
  local now

  [[ -n "$STATE_QUEUED_MESSAGE" ]] || return 1

  now="$(date +%s)"
  if (( now < STATE_COOLDOWN_UNTIL )); then
    return 1
  fi
  if ! driver_accepting_injection; then
    return 1
  fi

  log "Flushing queued message (${STATE_QUEUED_REASON:-no reason})"
  deliver_to_driver "[${LENS}] $STATE_QUEUED_MESSAGE"
  mark_delivered "$STATE_QUEUED_HASH"
  save_state
  return 0
}

handle_observer_decision() {
  local action="$1"
  local reason="$2"
  local message="$3"
  local message_hash now

  case "$action" in
    noop|"")
      log "Observer: noop (${reason:-no reason})"
      return 0
      ;;
    queue|interrupt)
      ;;
    *)
      log "Observer returned unknown action '$action'"
      return 1
      ;;
  esac

  if [[ -z "$message" ]]; then
    log "Observer returned '$action' without a message"
    return 1
  fi

  if [[ "$DELIVERY_MODE" == "print" ]]; then
    printf '[%s %s] %s\n' "$LENS" "$action" "$message"
    return 0
  fi

  message_hash="$(hash_text "${action}|${message}")"
  if [[ "$message_hash" == "$STATE_QUEUED_HASH" ]] || [[ "$message_hash" == "$STATE_LAST_DELIVERED_HASH" ]] || recent_hash_seen "$message_hash"; then
    log "Suppressing duplicate ${action} message (${reason:-no reason})"
    return 0
  fi

  now="$(date +%s)"
  case "$action" in
    queue)
      log "Observer: queue (${reason:-no reason})"
      if (( now >= STATE_COOLDOWN_UNTIL )) && driver_accepting_injection; then
        deliver_to_driver "[${LENS}] $message"
        mark_delivered "$message_hash"
      else
        queue_message "$message" "$reason" "$message_hash"
      fi
      ;;
    interrupt)
      log "Observer: interrupt (${reason:-no reason})"
      if (( now >= STATE_COOLDOWN_UNTIL )); then
        if [[ "$DELIVERY_MODE" == "interrupt" ]]; then
          interrupt_and_deliver "[${LENS}] $message"
          mark_delivered "$message_hash"
        elif driver_accepting_injection; then
          deliver_to_driver "[${LENS}] $message"
          mark_delivered "$message_hash"
        else
          queue_message "$message" "$reason" "$message_hash"
        fi
      else
        queue_message "$message" "$reason" "$message_hash"
      fi
      ;;
  esac

  save_state
}

# =============================================================================
# Main observe loop
# =============================================================================

observe_loop() {
  require_tmux_session
  load_state

  local driver_sid busy pending decision action reason message

  driver_sid="$(wait_for_driver_session_id)"
  # Re-resolve in current shell to set DRIVER_PID (subshell lost it)
  resolve_bridge_session_id "$BRIDGE_SESSION_ID" >/dev/null
  STATE_LAST_DRIVER_SESSION_ID="$driver_sid"
  save_state

  # Derive the conversation JSONL path for change detection.
  # Claude Code stores conversations at ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
  local cwd_slug conv_file last_conv_mtime conv_mtime
  cwd_slug="$(printf '%s' "$WORKDIR" | sed 's|/|-|g')"
  conv_file="$HOME/.claude/projects/${cwd_slug}/${driver_sid}.jsonl"
  last_conv_mtime=0

  if [[ ! -f "$conv_file" ]]; then
    log "WARN: Conversation file not found at $conv_file — will poll without change detection"
  fi

  log "Bridge session: $BRIDGE_SESSION_ID"
  log "Driver session: $driver_sid (PID $DRIVER_PID)"
  log "Lens: $LENS"
  log "Delivery: $DELIVERY_MODE"
  log "State file: $STATE_FILE"

  while true; do
    # Verify the driver process is still alive
    if [[ -n "$DRIVER_PID" ]] && ! kill -0 "$DRIVER_PID" 2>/dev/null; then
      log "Driver process (PID $DRIVER_PID) is no longer running"
      break
    fi

    # Try to flush any queued message first
    if [[ "$DELIVERY_MODE" != "print" ]]; then
      flush_queued_message_if_possible || true
    fi

    # Check if conversation has changed since last epoch
    if [[ -f "$conv_file" ]]; then
      conv_mtime="$(stat -f %m "$conv_file" 2>/dev/null || echo 0)"
      if [[ "$conv_mtime" == "$last_conv_mtime" ]]; then
        log "Waiting for conversation change..."
        sleep "$POLL_INTERVAL"
        continue
      fi
    fi

    # Capture current state
    busy=false
    pending=false
    driver_is_busy && busy=true
    [[ -n "$STATE_QUEUED_MESSAGE" ]] && pending=true

    # Run observer epoch
    log "Polling (driver $(if [[ "$busy" == true ]]; then echo busy; else echo idle; fi))"
    if ! decision="$(run_observer_epoch "$driver_sid" "$busy" "$pending")"; then
      log "Observer epoch failed"
      sleep "$POLL_INTERVAL"
      continue
    fi
    last_conv_mtime="$(stat -f %m "$conv_file" 2>/dev/null || echo 0)"

    # Validate JSON response
    if ! jq -e . >/dev/null 2>&1 <<<"$decision"; then
      log "Observer returned invalid JSON, skipping"
      log "Raw decision (first 200 chars): $(head -c 200 <<<"$decision")"
      sleep "$POLL_INTERVAL"
      continue
    fi

    # Extract and handle decision
    action="$(decision_field "$decision" action)"
    reason="$(decision_field "$decision" reason)"
    message="$(decision_field "$decision" message)"

    record_decision "$action" "$reason" "$message"

    if ! handle_observer_decision "$action" "$reason" "$message"; then
      log "Decision handling failed"
    fi

    save_state
    sleep "$POLL_INTERVAL"
  done
}

# =============================================================================
# Entry point
# =============================================================================

observe_loop
