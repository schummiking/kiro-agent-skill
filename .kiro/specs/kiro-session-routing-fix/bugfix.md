# Bugfix 需求文档

## 简介

kiro-agent skill 的传输路由存在架构层面的严重缺陷。经过两轮事件分析（2026-03-22 初始事件 + 后续 bug report），问题比最初预期更深层：

**核心问题不仅是"bridge 未被定位为统一传输层"，而是三重缺陷叠加：**

1. **CLI 非交互作为回退路径不应存在**：保留 CLI 作为 fallback 给了 agent 不走 bridge 的借口，增加了不必要的复杂性。Bridge 是唯一传输层——如果 bridge 失败，那是需要修复的 bug，不是需要绕过的场景。
2. **约束力度不够**：skill 文档将 bridge 写为"DEFAULT"、`sessions_spawn` 写为"OPTIONAL ALTERNATIVE"，这种推荐性措辞在执行压力下被误读为"可以先试 direct ACP"。需要升级为硬性禁令。
3. **三个 ACP 概念被混为一谈**：ACP 协议、direct ACP via `sessions_spawn`、ACP bridge-as-process 三者未被明确区分，导致 agent 将"用 ACP"错误理解为"先试 `sessions_spawn`"。

项目中已有的 `kiro-acp-bridge.js` 是一个独立的 ACP 客户端，通过 stdin/stdout 通信，支持完整会话生命周期管理（`session/new`、`session/load`、`session/list`、`session/prompt`），且内置 L2+L3 通知机制。通过 OpenClaw 的 `exec(background:true)` + `process` 工具将其作为后台进程运行，可以完全绕过 `sessions_spawn` 线程绑定限制，在所有 surface 上提供统一的 ACP 会话能力。

此缺陷在 2026-03-22 的真实事件中被暴露——agent 在 Telegram surface 上先错误地尝试 direct `sessions_spawn(runtime:"acp")` 两次（缺少 `thread:true`，然后 Telegram 不支持 ACP thread spawn），bridge 从未被实际启动或测试。即使在之前的修复中将 bridge 定位为 DEFAULT，agent 仍然没有遵循 skill 约定，说明约束力度根本不够。

## Bug 分析

### 当前行为（缺陷）

1.1 WHEN agent 需要执行任何 Kiro 任务时 THEN transport routing 仍然保留 CLI 非交互作为"紧急回退"路径，这给了 agent 不走 bridge 的借口，增加了不必要的路由复杂性。Bridge 应该是唯一传输层，没有 fallback

1.2 WHEN agent 在 Telegram 上执行多轮任务时 THEN agent 先错误地尝试 direct `sessions_spawn(runtime:"acp")` 而不是先走 bridge。skill 文档的约束是推荐性的（"DEFAULT"/"OPTIONAL ALTERNATIVE"），不是硬性禁令，在执行压力下被误读

1.3 WHEN agent 看到"用 ACP"的指导时 THEN agent 将三个不同概念混为一谈：(a) ACP 协议本身（surface 无关），(b) direct ACP via `sessions_spawn`（surface 依赖，Telegram 不支持），(c) ACP bridge-as-process（surface 无关，所有 surface 可用）。文档未明确区分这三者

1.4 WHEN agent 需要为给定的 surface 选择传输方式时 THEN 没有强制性的 surface 能力预检步骤。agent 不会先检查当前 surface 是否支持 direct ACP spawn，就直接尝试

1.5 WHEN agent 需要通过 ACP bridge 管理会话生命周期时 THEN SKILL.md 没有记录完整的 bridge 会话工作流，包括 one-shot-via-bridge 模式

1.6 WHEN agent 执行 session continuity check 时 THEN 检查流程仅覆盖两条路径，没有覆盖 bridge 管理的 ACP 会话

1.7 WHEN agent 需要为给定的 surface 和场景选择正确的传输方式时 THEN 没有 (surface × scenario) 路由矩阵，也没有将 bridge 定位为唯一传输层的架构指导

### 期望行为（正确）

2.1 WHEN agent 需要执行任何 Kiro 任务时 THEN ACP bridge（`exec(background:true)` + `kiro-acp-bridge.js`）SHALL 作为唯一传输层（MANDATORY），用于所有场景（one-shot 和多轮）。CLI 非交互模式 SHALL 被完全移除，不作为任何形式的 fallback

2.2 WHEN agent 在 Telegram 或任何 chat surface 上执行任务时 THEN skill 文档 SHALL 包含硬性禁令：「在 Telegram / chat surfaces 上：必须使用 ACP bridge。禁止尝试 direct ACP thread spawn（`sessions_spawn(runtime:"acp")`）」。此禁令不是推荐，是硬性规则

2.3 WHEN agent 选择传输方式之前 THEN skill 文档 SHALL 要求执行强制性的 surface 能力预检（Surface Capability Pre-check）作为第一步：检查当前 surface 是否支持 direct ACP spawn，然后基于预检结果选择传输方式

2.4 WHEN skill 文档描述 ACP 相关内容时 THEN SHALL 明确区分三个概念：(a) ACP 协议——JSON-RPC 协议本身，surface 无关；(b) Direct ACP via `sessions_spawn`——OpenClaw 原生 ACP thread 绑定，surface 依赖，Telegram 不支持；(c) ACP bridge-as-process——bridge 脚本作为后台进程运行，surface 无关，所有 surface 可用。文档必须明确：「用 ACP」意味着「用 ACP bridge」，不是「先试 `sessions_spawn`」

2.5 WHEN agent 执行 one-shot 任务时 THEN bridge SHALL 支持 one-shot-via-bridge 模式：`session/new` → `session/prompt` → 等待 `prompt_completed` → `stop`。此模式天然保留会话，用户后续可追问

2.6 WHEN agent 需要为给定的 surface 和场景选择正确的传输方式时 THEN skill 文档 SHALL 提供一个 (surface × scenario) 路由矩阵。所有场景路由到 bridge（唯一传输层），`sessions_spawn` ACP 仅在桌面端/Web 作为可选替代

2.7 WHEN agent 需要通过 ACP bridge 管理会话生命周期时 THEN SKILL.md SHALL 包含完整的 bridge 工作流，覆盖多轮和 one-shot-via-bridge 两种模式

2.8 WHEN agent 执行 session continuity check 时 THEN 检查流程 SHALL 包含 bridge 路径：检查是否有运行中的 ACP bridge 进程，若有则通过 `process action:submit` 向 bridge 发送后续命令；若 bridge 未运行但存在有效会话的状态文件（`kiro-acp-state.json`），则启动新的 bridge 并通过 `session_load` 加载该会话

### 不变行为（回归防护）

3.1 WHEN agent 在支持 `sessions_spawn` ACP 的 surface（如桌面端）上执行多轮任务时 THEN `sessions_spawn` ACP SHALL 继续作为可选替代路径存在（bridge 为唯一默认）

3.2 WHEN session continuity check 检查现有的 OpenClaw 后台进程和 saved session 路径时 THEN 这两条现有路径 SHALL 继续正常工作，bridge 路径是新增的优先检查路径

3.3 WHEN agent 执行任务时 THEN 通知契约（L1/L2/L3/L4 通知层）和输出交付规则 SHALL 保持不变

3.4 WHEN agent 选择委派模式时 THEN 所有现有的委派模式定义和 prompting 模板 SHALL 保持不变
