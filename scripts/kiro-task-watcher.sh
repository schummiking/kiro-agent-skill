#!/usr/bin/env bash
# kiro-task-watcher.sh — Wraps a Kiro one-shot task with guaranteed completion notification.
#
# Usage:
#   bash kiro-task-watcher.sh <workdir> '<task prompt>'
#   bash kiro-task-watcher.sh <workdir> '<task prompt>' [kiro-extra-args...]
#
# What it does:
#   1. Runs kiro-cli chat --no-interactive --trust-all-tools with the given prompt
#   2. Injects a completion notification hook into the prompt (L1)
#   3. Fires openclaw system event on process exit regardless of how it exits (L2+L3)
#   4. Captures exit code and last lines of output for the notification
#
# Notification layers:
#   L1 — Prompt hook: Kiro is told to run openclaw system event on completion
#   L2 — Shell post-command: fires after kiro-cli exits normally
#   L3 — EXIT trap: fires even on signals/crashes

set -euo pipefail

WORKDIR="${1:?Usage: kiro-task-watcher.sh <workdir> '<task prompt>' [extra-args...]}"
TASK="${2:?Usage: kiro-task-watcher.sh <workdir> '<task prompt>' [extra-args...]}"
shift 2
EXTRA_ARGS=("$@")

TASK_SHORT="${TASK:0:80}"
LOG_FILE=$(mktemp /tmp/kiro-task-XXXXXX)
EXIT_CODE=0
NOTIFIED=0

notify() {
  [ "$NOTIFIED" -eq 1 ] && return
  NOTIFIED=1
  local status="$1"
  local detail="$2"
  openclaw system event --text "Kiro ${status}: ${detail}" --mode now 2>/dev/null || true
}

cleanup() {
  local code="${EXIT_CODE:-$?}"
  if [ "$NOTIFIED" -eq 0 ]; then
    local tail_output
    tail_output=$(tail -5 "$LOG_FILE" 2>/dev/null | head -c 200 || echo "(no output)")
    if [ "$code" -eq 0 ]; then
      notify "DONE" "${TASK_SHORT} | exit 0"
    else
      notify "FAILED" "${TASK_SHORT} | exit ${code} | ${tail_output}"
    fi
  fi
  # Keep log file for agent to read via process action:log
}

trap cleanup EXIT

cd "$WORKDIR"

PROMPT="${TASK}

COMPLETION NOTIFICATION (mandatory):
When you have fully completed the task, or determined it cannot be completed, execute this as your FINAL action:
  openclaw system event --text \"Kiro DONE: <one-line summary>\" --mode now
If you fail or cannot complete, run:
  openclaw system event --text \"Kiro FAILED: <reason>\" --mode now
Do not skip this step."

kiro-cli chat --no-interactive --trust-all-tools ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} "$PROMPT" 2>&1 | tee "$LOG_FILE" || EXIT_CODE=$?

exit "${EXIT_CODE}"
