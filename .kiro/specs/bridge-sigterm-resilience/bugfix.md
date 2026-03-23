# Bugfix Requirements Document

## Introduction

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 实测 Kiro Agent manual mode 时，bridge 在 `session_new` 成功后 1-3 秒内被宿主进程管理器发送的 SIGTERM 杀死。这是本系列第 5 个 bugfix（session-routing → process-stability → control-channel → signal-isolation → sigterm-resilience）。

前一个 bugfix（signal-isolation）解决了进程组隔离和 pending RPC grace period 问题。但当前场景中，`session_new` 刚完成、用户还没来得及发 `send`，此时 `pending.size === 0`，grace period 条件不满足，bridge 收到 SIGTERM 后立即执行 shutdown 并主动杀死 ACP 子进程。

关键证据：`terminatedBy: "bridge"`（bridge 自己的 SIGTERM handler 触发，不是进程组传播）、`pendingCalls: 0`（没有 in-flight RPC）、时间极短（session_new 后 1-3 秒）。SIGTERM 来源是 OpenClaw 的进程管理 / PTY / background session 生命周期管理。

修复方向包含两条路：(1) Bridge 侧 SIGTERM 防御——有活跃 session 时第一次 SIGTERM 被"吸收"而非立即 shutdown；(2) 启动方式改造——在 SKILL.md 中更新启动命令使 bridge 脱离宿主进程组。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 收到 SIGTERM 且有活跃 session（`acpReady && currentSessionId`）但 `pending.size === 0`（无 in-flight RPC） THEN bridge 立即执行 `gracefulShutdown('SIGTERM')`，主动 kill ACP 子进程并退出，用户还没来得及发送任何 prompt

1.2 WHEN bridge 通过 OpenClaw 的 `bash background:true` 启动且运行在宿主管理的后台进程中 THEN 宿主进程管理器可能在 session_new 成功后 1-3 秒内向 bridge 发送 SIGTERM（PTY / background session 生命周期管理），bridge 无法区分"宿主误杀"和"用户有意终止"

1.3 WHEN bridge 收到第一次 SIGTERM 时 THEN bridge 无条件执行 shutdown，没有任何"吸收"或"延迟"机制来保护有活跃 session 的场景，即使这次 SIGTERM 可能是宿主的误杀信号

### Expected Behavior (Correct)

2.1 WHEN bridge 收到 SIGTERM 且有活跃 session（`acpReady && currentSessionId`） THEN bridge SHALL "吸收"第一次 SIGTERM——记录警告事件（`bridge_signal_received` 含 `deferred: true`）但不执行 shutdown，继续正常运行

2.2 WHEN bridge 已吸收第一次 SIGTERM 后收到第二次 SIGTERM（确认性 kill） THEN bridge SHALL 立即执行 graceful shutdown（与现有 shutdown 逻辑一致，包括 pending RPC grace period）

2.3 WHEN bridge 已吸收第一次 SIGTERM 后超过 60 秒仍未收到第二次 SIGTERM THEN bridge SHALL 自动执行 graceful shutdown，防止 bridge 永远挂起

2.4 WHEN bridge 已吸收第一次 SIGTERM 后 ACP 已完成工作（`pending.size === 0` 且 `!currentSessionId`，即无活跃 session） THEN bridge SHALL 自动执行 graceful shutdown

2.5 WHEN bridge 收到 SIGTERM 且没有活跃 session（`!acpReady || !currentSessionId`） THEN bridge SHALL 立即执行 graceful shutdown（保持现有行为不变）

2.6 WHEN bridge 通过 SKILL.md 中的启动命令启动时 THEN 启动命令 SHALL 使用 `setsid` 或等效机制使 bridge 脱离宿主进程组，减少宿主误杀的概率

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户通过控制通道发送 `{"op":"stop"}` 命令 THEN bridge SHALL CONTINUE TO 立即终止 ACP 子进程并关闭，不受 SIGTERM 吸收机制影响

3.2 WHEN bridge 收到 SIGTERM 且没有活跃 session（`!acpReady || !currentSessionId`） THEN bridge SHALL CONTINUE TO 立即执行 graceful shutdown，行为与修复前完全一致

3.3 WHEN 用户通过控制通道（stdin 或 FIFO）发送有效的 JSONL 命令（start、session_new、send、reply、cancel、ping 等） THEN bridge SHALL CONTINUE TO 正确解析并执行对应操作，返回正确的事件响应

3.4 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件，保持 keepalive 机制

3.5 WHEN ACP 子进程发送 `session/update` 通知或 `session/request_permission` 请求 THEN bridge SHALL CONTINUE TO 正确处理并转发事件，自动权限处理策略不变

3.6 WHEN bridge 收到 SIGTERM 且存在 pending RPC（in-flight prompt） THEN bridge SHALL CONTINUE TO 执行现有的 grace period 逻辑（等待 pending 完成或 30 秒超时），此行为不受吸收机制影响（有 pending RPC 说明确实在工作中，应走 grace period 而非吸收）

3.7 WHEN bridge 以 `--control fifo` 模式运行 THEN bridge SHALL CONTINUE TO 通过 FIFO 控制通道接收命令，EOF 重连机制不变

3.8 WHEN `bridge_signal_received` 事件输出时 THEN bridge SHALL CONTINUE TO 包含 `signal`、`pendingCalls`、`timestamp` 字段（可新增 `deferred` 字段但不删除现有字段）
