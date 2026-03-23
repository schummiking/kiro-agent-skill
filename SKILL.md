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

## Three ACP concepts — do not conflate

These three things are **different**. Never treat them as interchangeable:

| Concept | What it is | Surface dependency |
| --- | --- | --- |
| **ACP protocol** | The JSON-RPC protocol itself (`initialize`, `session/new`, `session/prompt`, etc.) | None — surface-agnostic |
| **Direct ACP via `sessions_spawn`** | OpenClaw's native ACP thread binding. Calls `sessions_spawn(runtime:"acp")` to create a thread-bound ACP session. | **Surface-dependent** — requires thread support. NOT supported on Telegram. |
| **ACP bridge-as-process** | The bridge script (`kiro-acp-bridge.js`) running as a background process via `exec(background:true)`. Control input via FIFO, event output via stdout JSONL. | None — surface-agnostic, works everywhere. |

**Critical rule: "use ACP" means "use ACP bridge", NOT "try `sessions_spawn` first".**

## Surface capability pre-check (MANDATORY first step)

**Before selecting any transport, you MUST check the current surface's capabilities:**

1. **Identify current surface**: Desktop/Web, Telegram, or other restricted surface
2. **Check direct ACP support**: Does this surface support `sessions_spawn(runtime:"acp")` with thread binding?
   - Desktop/Web: ✅ Supported
   - Telegram: ❌ NOT supported — **PROHIBITED**
   - Other restricted surfaces: ❌ Assume NOT supported
3. **Select transport based on pre-check result**:
   - All surfaces → ACP bridge (MANDATORY)
   - Desktop/Web only → may optionally use `sessions_spawn` ACP as alternative

**On Telegram / chat surfaces: MUST use ACP bridge. Do NOT attempt direct ACP thread spawn (`sessions_spawn(runtime:"acp")`). This is PROHIBITED, not optional.**

## Transport routing

| Priority | Scenario | Transport |
| --- | --- | --- |
| **MANDATORY (all scenarios)** | One-shot AND multi-turn | ACP bridge-as-process: `exec(background:true)` + `setsid node scripts/kiro-acp-bridge.js --control fifo`. The ONLY transport layer for every surface and scenario. |
| OPTIONAL ALTERNATIVE | Multi-turn on Desktop/Web only (surfaces that support `sessions_spawn`) | `sessions_spawn` ACP / direct `kiro-cli acp --agent ... --model ... --trust-all-tools`. **PROHIBITED on Telegram.** |
| Never use interactive TUI chat as a transport inside this skill | | |

### Routing matrix (surface × scenario)

| Surface | Multi-turn | One-shot | Session resume |
| --- | --- | --- | --- |
| Desktop / Web | Bridge (MANDATORY) or `sessions_spawn` ACP (optional alternative) | Bridge one-shot-via-bridge | Bridge `session_load` |
| Telegram | Bridge (MANDATORY) — direct ACP spawn **PROHIBITED** | Bridge one-shot-via-bridge | Bridge `session_load` |
| Other restricted surfaces | Bridge (MANDATORY) | Bridge one-shot-via-bridge | Bridge `session_load` |

**Routing rule:** Bridge is the ONLY transport. No fallback. If bridge fails, that's a bug to fix — not a scenario to work around.

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
| 用 Kiro 一次跑完 / one-shot | Bridge one-shot-via-bridge (唯一传输方式) |
| 用某个 Kiro agent 干活 | Bridge: `{"op":"start","agent":"backend-specialist",...}` |
| 看 Kiro 会话 | `kiro-cli chat --list-sessions` |
| 恢复 Kiro 会话 | `kiro-cli chat --resume` |
| 删除 Kiro 会话 | `kiro-cli chat --delete-session ID` (confirm first) |
| 看/创建/编辑 Kiro agent | `kiro-cli agent list/create/edit NAME` |
| 设默认 agent | `kiro-cli agent set-default NAME` |
| 看/改默认模型 | `kiro-cli settings chat.defaultModel [VALUE]` |
| 看/改默认 agent | `kiro-cli settings chat.defaultAgent [VALUE]` |
| 看 Kiro 设置 | `kiro-cli settings list [--all]` |
| Kiro MCP | `kiro-cli mcp list/add/remove/status ...` |
| Kiro ACP | ACP bridge workflow (MANDATORY); direct `kiro-cli acp` (optional alternative on Desktop/Web only, PROHIBITED on Telegram) |
| Kiro bridge / Kiro ACP bridge / 用 bridge 跑 | Start ACP bridge workflow (see bridge section) |
| Kiro bridge 恢复 / bridge resume | Check bridge state file, `session_load` via bridge |
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

Check in this order (bridge first):

**2a — Check for a running ACP bridge process (highest priority):**
```bash
process action:list
```
Look for a running `kiro-acp-bridge.js` process. If found → send the follow-up via FIFO write (`echo '{"op":"send",...}' > /tmp/kiro-acp-bridge-PID.fifo`) with a `send` or `reply` JSONL command to the bridge. Done.

**2b — Check for bridge state file (if no running bridge):**

If no running bridge process, check if the bridge state file exists and has a valid session:
```
scripts/kiro-agent/scripts/kiro-acp-state.json
```
If a valid session is found → start a new bridge, send `start` + `session_load` to resume the session. Done.

**2c — Check for other live background processes:**
```bash
process action:list
```
Look for other Kiro processes (non-bridge). If a relevant Kiro process is still running → use `process action:submit` to send the follow-up into that session. Done.

**2d — Check Kiro saved sessions (fallback):**
```bash
kiro-cli chat --list-sessions
```
Then:
- If **one obvious match** (same project, recent) → resume via bridge: start a new bridge, `session_load` the session
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

### ACP bridge (unified default transport)

The ACP bridge is the MANDATORY transport for **all** Kiro tasks — both one-shot and multi-turn. It provides session preservation, multi-turn support on every surface, and built-in L2+L3 notifications. There is no fallback — if bridge fails, that's a bug to fix.

Bridge protocol details: [references/acp-bridge-protocol.md](references/acp-bridge-protocol.md)

#### Multi-turn workflow via bridge

**Step 1** — Launch bridge as background process:
```bash
bash workdir:~/project background:true command:"setsid node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js --control fifo"
```

**Step 1.5** — Read log to get FIFO control path:
```bash
process action:log sessionId:XXX
```
Look for `{"type":"control_channel","mode":"fifo","path":"/tmp/kiro-acp-bridge-PID.fifo"}` in the output. Extract the FIFO path for subsequent commands.

**Step 2** — Send `start` command to launch the ACP process:
```bash
echo '{"op":"start","agent":"kiro_default","model":"claude-opus-4.6","trustAllTools":true}' > /tmp/kiro-acp-bridge-PID.fifo
```

**Step 3** — Confirm `ready` event:
```bash
process action:log sessionId:XXX
```
Look for `{"type":"ready",...}` in the output.

**Step 4** — Create a new session:
```bash
echo '{"op":"session_new","cwd":"/absolute/path/project"}' > /tmp/kiro-acp-bridge-PID.fifo
```
`cwd` is optional — if omitted, defaults to the bridge process's working directory (set by `workdir:` in the launch command). If provided, must be an absolute path.

**Step 5** — Send a prompt:
```bash
echo '{"op":"send","session":"sess_xxx","text":"Your task here"}' > /tmp/kiro-acp-bridge-PID.fifo
```

**Step 6** — Read `session_update` and `prompt_completed` events:
```bash
process action:log sessionId:XXX
```
Look for `{"type":"session_update",...}` (streaming progress) and `{"type":"prompt_completed",...}` (task finished).

**Step 7** — For follow-ups, send more `send` or `reply` commands:
```bash
echo '{"op":"send","session":"sess_xxx","text":"Now do this follow-up"}' > /tmp/kiro-acp-bridge-PID.fifo
```

**Step 8** — To resume a previous session later:
```bash
echo '{"op":"session_load","session":"sess_xxx","cwd":"/absolute/path/project"}' > /tmp/kiro-acp-bridge-PID.fifo
```

**Step 9** — To stop the bridge:
```bash
echo '{"op":"stop"}' > /tmp/kiro-acp-bridge-PID.fifo
```

#### One-shot-via-bridge workflow

Same as multi-turn but streamlined: `session_new` → `send` → wait for `prompt_completed` → `stop`.

1. Launch bridge + send `start` + confirm `ready` (Steps 1–3 above)
2. `session_new` to create a session
3. `send` to send the prompt
4. Wait for `prompt_completed` event via `process action:log`
5. `stop` to shut down the bridge

**Key advantage over CLI non-interactive:** the session is naturally preserved. If the user later says "继续上次的", you can start a new bridge and use `session_load` to resume — no context is lost. CLI non-interactive discards the session entirely.

#### Bridge lifecycle — when to stop

| Scenario | When to send `op:stop` |
| --- | --- |
| One-shot task | Immediately after `prompt_completed` — bridge is disposable |
| Multi-turn (all modes) | Keep bridge running between turns. Only stop when: |
| | • User explicitly says "结束 Kiro" / "关闭 Kiro" / "stop Kiro" |
| | • User starts a completely unrelated project (stop old bridge, start new) |
| | • OpenClaw conversation ends or user leaves |
| Manual mode | Same as multi-turn — bridge stays alive until user says done |

**Key principle:** In multi-turn scenarios, the bridge is a long-lived daemon. Do NOT stop it after each prompt — the user may come back minutes or hours later with a follow-up. The 30s heartbeat keeps it alive indefinitely.

**If the bridge dies unexpectedly** (crash, system kill, etc.):
1. Start a new bridge
2. Use `session_load` with the previous session ID (from state file or `kiro-cli chat --list-sessions`)
3. Continue where you left off — session data lives on Kiro's server, not in the bridge

#### Bridge state and notifications

- Bridge writes state to `scripts/kiro-agent/scripts/kiro-acp-state.json` (current pid, readiness, session IDs, cwd bindings)
- Bridge has built-in L2+L3 notification via `openclaw system event` — fires on `prompt_completed` and on ACP process exit
- Bridge auto-handles permissions: `allow_always` > `allow_once` > `cancelled`

### With a specific Kiro custom agent

When using the bridge, specify the agent in the `start` command:

```bash
echo '{"op":"start","agent":"backend-specialist","model":"claude-opus-4.6","trustAllTools":true}' > /tmp/kiro-acp-bridge-PID.fifo
```

On Desktop/Web only (where `sessions_spawn` is supported), you may alternatively use:
```bash
kiro-cli acp --agent backend-specialist --model claude-opus-4.6 --trust-all-tools
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
