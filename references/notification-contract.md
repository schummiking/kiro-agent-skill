# Notification Contract & Progress Monitoring

## Core principle

The agent that starts a Kiro task owns the notification obligation until the user has been informed of the outcome. "Informed" means the user received a message through their active channel (Telegram / main session). Logging internally does not count.

## Notification guarantee layers

Every Kiro task launch must use at least L1 + L2. L3 and L4 add defense-in-depth.

| Layer | Mechanism | Who executes | Reliability |
| --- | --- | --- | --- |
| L1 — Prompt hook | Kiro's prompt includes `openclaw system event` on completion | Kiro subprocess | High |
| L2 — Shell wrapper | `; openclaw system event ...` after Kiro invocation | Shell | High |
| L3 — Watcher script | `kiro-task-watcher.sh` wraps Kiro, catches all exit paths | Shell wrapper | Very high |
| L4 — Agent poll fallback | Agent polls `process action:poll` on schedule | OpenClaw agent | Medium |

## How to launch with notification guarantees

### One-shot tasks (preferred — uses watcher script for L1+L2+L3)

```bash
bash workdir:~/project background:true command:"bash ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-task-watcher.sh ~/project 'Your task here'"
```

### Fallback: inline two-layer (L1+L2, if watcher unavailable)

```bash
bash workdir:~/project background:true command:"kiro-cli chat --no-interactive --trust-all-tools 'Your task here.

When completely finished, run: openclaw system event --text \"Kiro DONE: <summary>\" --mode now
If you fail, run: openclaw system event --text \"Kiro FAILED: <reason>\" --mode now' ; openclaw system event --text 'Kiro process exited' --mode now"
```

### ACP tasks

The ACP bridge (`kiro-acp-bridge.js`) automatically fires `openclaw system event` on `prompt_completed` and on process exit. L2+L3 are built in.

### Foreground one-shot (short tasks)

No notification layers needed — you see the result immediately. Still push a summary to the user.

## What counts as "notifying the user"

- ✅ Sending a message in the active conversation (Telegram, main session)
- ✅ `openclaw system event --text "..." --mode now`
- ✅ Writing a report to `/tmp/kiro-reports/kiro-report-YYYYMMDD-HHMMSS.md` and sending it as a Telegram attachment
- ❌ Only writing to internal logs or memory files
- ❌ Only updating a state JSON
- ❌ Saying something in a compacted-away context
- ❌ Pasting raw Kiro output directly into chat (use report file instead for anything longer than a few lines)

## Output delivery format

When delivering Kiro output to the user (on completion, failure, meaningful poll, or user request):

1. Read the log via `process action:log`
2. Write a cleaned-up report to `/tmp/kiro-reports/kiro-report-YYYYMMDD-HHMMSS.md`
3. Send the file as a **Telegram attachment** with a short summary message
4. Report contents: status header, task description, **credits used**, **elapsed time**, cleaned output (no ANSI/spinner noise), change summary, errors if any

## Submit-and-verify rule for follow-up tasks

When sending a new task into an already-running Kiro session via `process submit`:
1. Submit the task
2. Verify the session accepted it by checking for fresh output reflecting the new assignment
3. If log doesn't show the new task being picked up → retry or restart
4. Only report "task started" after confirming in session output

## Noise filtering

- Do NOT spam the user with routine logs, thinking animations, or package download noise
- DO proactively update when: milestone completes, error/blocker appears, Kiro asks for human input, task finishes
- Use 5-minute poll fallback only to detect missed events, silent hangs, or quiet failures
