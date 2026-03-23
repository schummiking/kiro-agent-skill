# kiro-agent-skill

**Use Claude models through your Kiro subscription — no separate API key needed.**

Kiro includes access to Claude (claude-opus-4.6 and others) as part of its subscription. This skill bridges OpenClaw to Kiro CLI, letting you drive Claude-powered coding tasks from OpenClaw without paying for Claude API separately. It's the most cost-effective way to run Claude in your OpenClaw workflows if you already have a Kiro account.

---

An [OpenClaw](https://openclaw.ai) skill that integrates [Kiro CLI](https://kiro.dev) as a dedicated coding and terminal agent. It lets OpenClaw orchestrate Kiro for complex, long-running development tasks — with full session management, multiple delegation modes, and guaranteed completion notifications.

---

## Overview

This skill implements a three-party model:

- **User** — sets goals, makes major decisions, owns final approval
- **OpenClaw (this skill)** — plans tasks, delegates to Kiro, monitors progress, filters noise, escalates when needed
- **Kiro** — executes coding and terminal work inside the target project

OpenClaw acts as the orchestrator. It translates user intent into concrete Kiro prompts, chooses the right transport and delegation mode, monitors execution, and delivers results — without drowning the user in raw output.

---

## Features

- **One-shot tasks** — run a bounded coding task via ACP bridge one-shot-via-bridge workflow
- **ACP orchestration** — multi-turn programmatic control via ACP bridge (`kiro-acp-bridge.js`)
- **Session management** — list, resume, and delete Kiro chat sessions
- **Custom agent support** — target specific Kiro agents by name
- **Four delegation modes** — Manual, Semi Auto (default), Agent Guided Full Auto, Kiro One Shot
- **Guaranteed notifications** — three-layer notification system (prompt hook + shell wrapper + EXIT trap) ensures the user is always informed when a task completes or fails
- **Background task monitoring** — automatic polling, stuck detection, and report delivery via file attachment

---

## File Structure

```
kiro-agent/
├── SKILL.md                          # Skill definition and routing logic (loaded by OpenClaw)
├── scripts/
│   ├── kiro-task-watcher.sh          # Shell wrapper with L1+L2+L3 notification guarantees
│   └── kiro-acp-bridge.js            # Lightweight ACP JSON-RPC bridge for multi-turn automation
├── references/
│   ├── command-reference.md          # Full kiro-cli command reference
│   ├── delegation-modes.md           # Mode definitions and prompting templates
│   ├── acp-bridge-protocol.md        # ACP bridge protocol spec and event reference
│   └── notification-contract.md      # Notification layers and output delivery rules
└── tests/
    ├── test-bug-condition.sh         # Session routing bug condition checks
    ├── test-preservation.sh          # Session routing preservation checks
    ├── test-bug-condition-exploration.js  # Bridge stability bug condition checks
    └── test-preservation-properties.js   # Bridge stability preservation checks
```

---

## Delegation Modes

| Mode | When to use | Who decides |
|---|---|---|
| Manual (Relay) | Tight control, unclear requirements | User decides everything |
| Semi Auto | Normal dev work (default) | Agent handles routine, escalates major |
| Agent Guided Full Auto | Long tasks with clear goals | Agent drives end-to-end |
| Kiro One Shot | Well-bounded single-pass tasks | Kiro attempts one pass, agent recovers if needed |

If no mode is specified, **Semi Auto** is used.

---

## Transport

ACP bridge (`kiro-acp-bridge.js`) is the **sole transport** for all scenarios:

| Scenario | Transport |
|---|---|
| Multi-turn orchestration | ACP bridge (MANDATORY) |
| One-shot task | ACP bridge one-shot-via-bridge (MANDATORY) |
| Session resume | ACP bridge `session_load` |

On Desktop/Web, direct `sessions_spawn` ACP is available as an optional alternative. On Telegram and other restricted surfaces, bridge is the only option — direct ACP spawn is **prohibited**.

Interactive TUI chat is never used as a transport inside this skill.

---

## Notification Layers

Every background task launch uses at least L1 + L2. L3 adds crash safety.

| Layer | Mechanism |
|---|---|
| L1 — Prompt hook | Kiro's prompt instructs it to run `openclaw system event` on completion |
| L2 — Shell post-command | Shell fires notification after `kiro-cli` exits normally |
| L3 — EXIT trap | `kiro-task-watcher.sh` catches all exit paths including signals and crashes |

---

## Requirements

- [Kiro CLI](https://kiro.dev) installed and authenticated (`kiro-cli login`)
- [OpenClaw](https://openclaw.ai) with skill loading support
- `kiro-cli` available in PATH (typically at `~/.local/bin/kiro-cli`)
- Node.js (for `kiro-acp-bridge.js`)

---

## Usage

Once installed as an OpenClaw skill, trigger it by mentioning Kiro explicitly:

> "用 Kiro 帮我重构这个模块"
> "Kiro one-shot: add unit tests for auth.ts"
> "恢复上次的 Kiro 会话"
> "用 Kiro full auto 模式跑完这个任务"

OpenClaw will automatically route to this skill and handle the rest.

---

## Red-line Escalation

Regardless of delegation mode, the agent always escalates before:

- Deleting important data or large code regions
- Deploy / release / publish actions
- Credential, auth, or security changes
- Database schema migrations
- Major architecture changes
- Any irreversible or external side-effect operations

---

---

# kiro-agent-skill（中文说明）

**通过 Kiro 订阅使用 Claude 模型，无需单独购买 API。**

Kiro 订阅内置了对 Claude（claude-opus-4.6 等）的访问权限。本 Skill 将 OpenClaw 与 Kiro CLI 桥接，让你在 OpenClaw 工作流中直接调用 Claude 驱动的编程能力，无需额外支付 Claude API 费用。如果你已有 Kiro 账号，这是在 OpenClaw 中运行 Claude 最经济的方式。

---

一个 [OpenClaw](https://openclaw.ai) Skill，将 [Kiro CLI](https://kiro.dev) 集成为专用的编程和终端 Agent。它让 OpenClaw 能够编排 Kiro 执行复杂、长时间运行的开发任务，支持完整的会话管理、多种委托模式，以及有保障的任务完成通知。

---

## 概述

本 Skill 实现了一个三方协作模型：

- **用户** — 设定目标，做重大决策，拥有最终审批权
- **OpenClaw（本 Skill）** — 规划任务，委托给 Kiro，监控进度，过滤噪音，必要时上报
- **Kiro** — 在目标项目中执行编程和终端操作

OpenClaw 作为编排者，将用户意图转化为具体的 Kiro 任务，选择合适的传输方式和委托模式，监控执行过程，并以整洁的报告形式交付结果。

---

## 功能特性

- **一次性任务** — 通过 ACP 桥接 one-shot-via-bridge 工作流执行有边界的编程任务
- **ACP 编排** — 通过 ACP 桥接 (`kiro-acp-bridge.js`) 实现多轮程序化控制
- **会话管理** — 列出、恢复、删除 Kiro 聊天会话
- **自定义 Agent 支持** — 按名称指定特定的 Kiro Agent
- **四种委托模式** — 手动、半自动（默认）、Agent 全自动、Kiro 一次性
- **有保障的通知** — 三层通知机制（Prompt 钩子 + Shell 包装 + EXIT 陷阱），确保任务完成或失败时用户始终收到通知
- **后台任务监控** — 自动轮询、卡死检测，以及通过文件附件交付报告

---

## 文件结构

```
kiro-agent/
├── SKILL.md                          # Skill 定义和路由逻辑（由 OpenClaw 加载）
├── scripts/
│   ├── kiro-task-watcher.sh          # 带 L1+L2+L3 通知保障的 Shell 包装脚本
│   └── kiro-acp-bridge.js            # 用于多轮自动化的轻量级 ACP JSON-RPC 桥接
├── references/
│   ├── command-reference.md          # 完整的 kiro-cli 命令参考
│   ├── delegation-modes.md           # 模式定义和 Prompt 模板
│   ├── acp-bridge-protocol.md        # ACP 桥接协议规范和事件参考
│   └── notification-contract.md      # 通知层级和输出交付规则
└── tests/
    ├── test-bug-condition.sh         # 会话路由 bug 条件检查
    ├── test-preservation.sh          # 会话路由保留性检查
    ├── test-bug-condition-exploration.js  # 桥接稳定性 bug 条件检查
    └── test-preservation-properties.js   # 桥接稳定性保留性检查
```

---

## 委托模式

| 模式 | 适用场景 | 决策者 |
|---|---|---|
| 手动（中继） | 需要严格控制、需求不明确 | 用户决定一切 |
| 半自动 | 日常开发工作（默认） | Agent 处理常规，重大决策上报 |
| Agent 全自动 | 目标明确的长任务 | Agent 全程驱动 |
| Kiro 一次性 | 边界清晰的单次任务 | Kiro 尝试一次完成，Agent 兜底恢复 |

未指定模式时，默认使用**半自动**。

---

## 传输方式

ACP 桥接 (`kiro-acp-bridge.js`) 是所有场景的**唯一传输层**：

| 场景 | 传输方式 |
|---|---|
| 多轮编排 | ACP 桥接（强制） |
| 一次性任务 | ACP 桥接 one-shot-via-bridge（强制） |
| 会话恢复 | ACP 桥接 `session_load` |

在桌面端/Web 上，直接 `sessions_spawn` ACP 可作为可选替代。在 Telegram 及其他受限 surface 上，桥接是唯一选项——直接 ACP spawn **被禁止**。

本 Skill 内部不使用交互式 TUI 聊天作为传输方式。

---

## 通知层级

每次后台任务启动至少使用 L1 + L2，L3 提供崩溃安全保障。

| 层级 | 机制 |
|---|---|
| L1 — Prompt 钩子 | Kiro 的 Prompt 中包含完成时执行 `openclaw system event` 的指令 |
| L2 — Shell 后置命令 | `kiro-cli` 正常退出后 Shell 触发通知 |
| L3 — EXIT 陷阱 | `kiro-task-watcher.sh` 捕获所有退出路径，包括信号和崩溃 |

---

## 环境要求

- 已安装并认证的 [Kiro CLI](https://kiro.dev)（`kiro-cli login`）
- 支持 Skill 加载的 [OpenClaw](https://openclaw.ai)
- `kiro-cli` 在 PATH 中可用（通常位于 `~/.local/bin/kiro-cli`）
- Node.js（用于 `kiro-acp-bridge.js`）

---

## 使用方式

安装为 OpenClaw Skill 后，通过明确提及 Kiro 来触发：

> "用 Kiro 帮我重构这个模块"
> "Kiro one-shot: 给 auth.ts 加单元测试"
> "恢复上次的 Kiro 会话"
> "用 Kiro full auto 模式跑完这个任务"

OpenClaw 会自动路由到本 Skill 并处理后续所有操作。

---

## 红线上报

无论处于哪种委托模式，以下操作前 Agent 始终会上报用户：

- 删除重要数据或大段代码
- 部署 / 发布 / 上线操作
- 凭证、认证或安全相关变更
- 数据库 Schema 迁移
- 重大架构变更
- 任何不可逆或有外部副作用的操作
