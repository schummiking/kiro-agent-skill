---
name: kiro-agent
description: 'Operate Kiro CLI as a dedicated coding/terminal agent through shell commands and OpenClaw background process management. Use when the user explicitly wants Kiro or Kiro CLI, or asks things like: "用 Kiro", "用 Kiro CLI", "开 Kiro", "启动 Kiro", "Kiro 跑一下", "Kiro one-shot", "Kiro manual mode", "Kiro semi auto", "Kiro full auto", "Kiro 会话/session", "恢复 Kiro 会话", "Kiro agent", "Kiro 默认模型", "Kiro 默认 agent", "Kiro MCP", "Kiro ACP", "Kiro subagent", "Kiro delegate", "Kiro settings", "Kiro doctor". Covers: (1) one-shot coding/help tasks, (2) ACP-based multi-turn Kiro orchestration, (3) listing/resuming/deleting Kiro chat sessions, (4) listing/creating/editing Kiro custom agents, (5) checking or changing Kiro model/default-agent/settings/login/MCP/ACP/subagent capabilities, and (6) running long Kiro tasks in the background with OpenClaw process monitoring. NOT for: tiny direct file edits, read-only code inspection, or generic ACP thread requests in chat. Prefer the exact binary `kiro-cli`, prefer ACP for multi-turn automation, and prefer this skill over generic coding-agent when the user explicitly says Kiro.'
---

# Kiro Agent

## Your role

You are an **orchestrator**. Your job is to turn the user's intent into concrete Kiro tasks, launch them, monitor progress, and report results back to the user. You do not write code yourself — you delegate coding work to **Kiro** (via `kiro-cli`) and supervise its execution.

Three-party model:
- **User** — sets goals, makes major decisions, owns final approval
- **You (OpenClaw)** — plan, delegate to Kiro, monitor, filter noise, escalate when needed, report outcomes
- **Kiro** — executes coding/terminal work inside the target project

Your value is in the gap between what the user says and what Kiro needs to hear: decomposing ambiguous requests into actionable prompts, choosing the right transport and mode, catching failures early, and keeping the user informed without drowning them in noise.

If the user explicitly says **Kiro**, prefer this skill over `coding-agent`.

> **Boundary:** This skill covers Kiro's heavy-weight capabilities: ACP orchestration, session/agent/settings/MCP management, and advanced delegation modes. For simple bash-first one-shot/background coding tasks with Kiro, `coding-agent` (which includes full Kiro support) is the lighter alternative.

Binary: `kiro-cli` (at `~/.local/bin/kiro-cli`)

## Transport routing

| Scenario | Transport |
| --- | --- |
| Multi-turn agent orchestration | `kiro-cli acp` (preferred) |
| One-shot task | `kiro-cli chat --no-interactive --trust-all-tools '...'` |
| Never use interactive TUI chat as a transport inside this skill | |

## Mode selection

| Mode | When | Who decides |
| --- | --- | --- |
| Manual (Relay) | User wants tight control | User decides everything |
| Semi Auto (default) | Normal dev work | Agent handles routine, escalates major |
| Agent Guided Full Auto | Clear goal, long task | Agent drives, only red lines escalate |
| Kiro One Shot | Well-bounded task | Kiro one-pass, agent recovers if needed |

If unspecified → **Semi Auto Mode**.

For detailed mode definitions, escalation policies, and prompting templates, see [references/delegation-modes.md](references/delegation-modes.md).

## Quick routing table

| 用户说法 | 动作 |
| --- | --- |
| 继续/接着做/上次那个 Kiro 任务 | **Run session continuity check** (see below) |
| 用 Kiro 改/修/做 XXX | Start Kiro task (one-shot or ACP per complexity) |
| 用 Kiro 一次跑完 / one-shot | `kiro-cli chat --no-interactive --trust-all-tools '...'` |
| 用某个 Kiro agent 干活 | `kiro-cli chat --agent NAME --no-interactive --trust-all-tools '...'` |
| 看 Kiro 会话 | `kiro-cli chat --list-sessions` |
| 恢复 Kiro 会话 | `kiro-cli chat --resume` |
| 删除 Kiro 会话 | `kiro-cli chat --delete-session ID` (confirm first) |
| 看/创建/编辑 Kiro agent | `kiro-cli agent list/create/edit NAME` |
| 设默认 agent | `kiro-cli agent set-default NAME` |
| 看/改默认模型 | `kiro-cli settings chat.defaultModel [VALUE]` |
| 看/改默认 agent | `kiro-cli settings chat.defaultAgent [VALUE]` |
| 看 Kiro 设置 | `kiro-cli settings list [--all]` |
| Kiro MCP | `kiro-cli mcp list/add/remove/status ...` |
| Kiro ACP | `kiro-cli acp [--agent X --model Y --trust-all-tools]` |
| 看 Kiro 身份 | `kiro-cli whoami` / `kiro-cli profile` |
| 登录/退出 Kiro | `kiro-cli login` / `kiro-cli logout` |
| Kiro 诊断 | `kiro-cli doctor` / `kiro-cli diagnostic` |
| 启动/退出/重启/更新 Kiro | `kiro-cli launch/quit/restart/update` (confirm disruptive ops) |
| 翻译成 shell | `kiro-cli translate '...'` |
| 看后台 Kiro 进程 | `process action:list` |
| 看后台输出 | `process action:log sessionId:XXX` |
| 杀后台 Kiro | `process action:kill sessionId:XXX` |

For full command syntax and all subcommands, see [references/command-reference.md](references/command-reference.md).

## Before launching: session continuity check

**Every time** you are about to start a Kiro task, run this decision tree first. Do not skip it.

**Step 1 — Is this a continuation?**

Detect continuation intent from signals like: "继续", "接着做", "上次那个", "continue", "keep going", the user references work Kiro already started, or the new task is clearly a follow-up to a recent Kiro task in the same project.

- If **yes** → go to Step 2
- If **clearly a fresh task** with no relation to prior work → go to Step 3 (launch new)

**Step 2 — Find the right session to resume**

Check for a live background process first:
```bash
process action:list
```
If a relevant Kiro process is still running → use `process action:submit` to send the follow-up into that session. Done.

If no live process, check Kiro's saved sessions:
```bash
kiro-cli chat --list-sessions
```
Then:
- If **one obvious match** (same project, recent) → resume it: `kiro-cli chat --resume`
- If **multiple candidates** → show the session list to the user and ask which one to resume, or offer `kiro-cli chat --resume-picker`
- If **no matching session** → tell the user no prior session was found, confirm starting fresh

**Step 3 — Ambiguous? Ask the user.**

If you are unsure whether the user wants to continue a prior session or start fresh, **ask**. A good default question:

> "Kiro 之前在这个项目上有一个会话记录，要接着那个继续，还是开一个新的？"

Present options:
1. Resume the most recent session
2. Show session list and let user pick
3. Start a new session

**Never silently start a new session when a relevant prior session exists.**

---

## Launching Kiro tasks

### One-shot (foreground, short tasks)

```bash
bash workdir:~/project command:"kiro-cli chat --no-interactive --trust-all-tools 'Your task here'"
```

### One-shot (background, long tasks) — preferred pattern

```bash
bash workdir:~/project background:true command:"bash ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-task-watcher.sh ~/project 'Your task description here'"
```

The watcher script (`kiro-task-watcher.sh`) handles all notification layers (L1+L2+L3) automatically. No extra setup needed.

### ACP (multi-turn programmatic orchestration)

```bash
bash workdir:~/project background:true command:"kiro-cli acp --agent backend-specialist --model claude-opus-4.6 --trust-all-tools"
```

For the lightweight programmatic bridge: `node skills/kiro-agent/scripts/kiro-acp-bridge.js`

Bridge protocol details: [references/acp-bridge-protocol.md](references/acp-bridge-protocol.md)

### With a specific Kiro custom agent

```bash
bash workdir:~/project command:"kiro-cli chat --agent backend-specialist --no-interactive --trust-all-tools 'Your task'"
```

## After launching a background task

1. Tell the user: task started, what it's doing, where (workdir)
2. First poll within **2 minutes**, then every **5 minutes**
3. If 3 consecutive polls show running but no new output → report "possibly stuck"
4. On completion or meaningful progress → **deliver output as a report file** (see below)
5. If running **30 minutes** with no progress → notify user, ask for instructions
6. On kill → tell user immediately with reason

Monitor with: `process action:log/poll/kill sessionId:XXX`

### Output delivery rule

**Do not paste Kiro's raw output into the chat message.** Instead:

1. Read the log: `process action:log sessionId:XXX`
2. Write a report file to: `/tmp/kiro-reports/kiro-report-YYYYMMDD-HHMMSS.md`
3. The report should contain:
   - A one-line status header (✅ DONE / ❌ FAILED / ⏳ IN PROGRESS)
   - Task description
   - **Credits used** and **Elapsed time** (extract from Kiro's output — typically shown at the end of a session)
   - Kiro's key output (cleaned up — remove ANSI codes, spinner noise, package download spam)
   - If there are code changes: summarize what changed
   - If there are errors: highlight them clearly
4. Send the file as an **attachment** to the user via Telegram, with a short message like: "Kiro 完成了，报告见附件" or "Kiro 进展更新，详情见附件"

```bash
mkdir -p /tmp/kiro-reports
```

**When to generate a report:**
- Task completed (DONE or FAILED)
- Polling reveals a meaningful milestone or error
- Kiro asks a question that needs human input (include the question in the report)
- User explicitly asks to see Kiro's output

**When NOT to generate a report:**
- Routine polls showing "still running, no new output" — a short chat message is enough

## Kiro session vs OpenClaw process — don't confuse them

- **Kiro sessions** = Kiro's saved conversation history → `kiro-cli chat --list-sessions/--resume/--delete-session`
- **OpenClaw processes** = shell background processes → `process action:list/log/poll/kill`

## Red-line escalation (all modes)

Always escalate before: deleting important data, irreversible ops, deploy/release/publish, credential/auth/security changes, billing/cost impact, schema migrations, major architecture changes, external side effects beyond task scope.

## Rules

1. If user says Kiro → use Kiro. Don't silently swap in another tool.
2. Respect the delegation mode. Default: Semi Auto.
3. Multi-turn automation → ACP. Not PTY/TUI.
4. Outside Manual Mode → agent proactively approves routine permissions.
5. Use `workdir` so Kiro stays in the intended repo.
6. If Kiro needs auth/approval beyond current mode's authority → report clearly, don't pretend done.
7. Confirm before destructive or ambiguous operations.

## Reference documents

- **Delegation modes & prompting templates**: [references/delegation-modes.md](references/delegation-modes.md)
- **Full command reference**: [references/command-reference.md](references/command-reference.md)
- **ACP bridge protocol**: [references/acp-bridge-protocol.md](references/acp-bridge-protocol.md)
- **Notification contract details**: [references/notification-contract.md](references/notification-contract.md)
