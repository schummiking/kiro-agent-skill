# Bugfix Requirements Document

## Introduction

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 实测中，SIGTERM 吸收机制（bugfix #5 sigterm-resilience 实现）已正确工作——bridge 收到第一次 SIGTERM 时输出 `deferred: true` 并继续运行。但 OpenClaw 的 process session（如 `ember-fjord`）在发送 SIGTERM 后被 OpenClaw 自己的进程管理层标记为 `failed`，导致 stdio pipe 不再可用。后续 `process action:submit` 命令失败："No active session found"。

这是本系列第 6 个 bugfix（session-routing → process-stability → control-channel → signal-isolation → sigterm-resilience → session-recovery）。

核心问题：bridge 存活但失去控制通道。SIGTERM 吸收后 bridge 仍在运行（heartbeat 继续），但 OpenClaw 的 stdio session 已失效，用户无法通过 `process action:submit` 向 bridge 发送新命令。现有的 stdin EOF → FIFO fallback 机制（`rl.on('close', ...)`）可能不触发，因为 OpenClaw session `failed` 不一定等于 stdin EOF。

修复方向：bridge 在吸收 SIGTERM 时（`deferred: true` 路径），应主动建立 FIFO 备用控制通道，而不是被动等待 stdin EOF。这样即使 OpenClaw 的 stdio session 挂了，bridge 仍然可以通过 FIFO 被控制。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 吸收 SIGTERM（`deferred: true`）后 OpenClaw 的 process session 被标记为 `failed` THEN bridge 仍在运行但没有主动建立 FIFO 备用控制通道，用户无法通过任何途径向 bridge 发送新命令

1.2 WHEN bridge 吸收 SIGTERM 后 OpenClaw 的 stdio pipe 不再被写入（但未必触发 EOF） THEN 现有的 stdin EOF → FIFO fallback 机制（`rl.on('close', ...)`）可能不触发，bridge 处于"存活但不可控"的僵死状态

1.3 WHEN bridge 吸收 SIGTERM 后用户尝试通过 `process action:submit` 发送后续命令 THEN OpenClaw 返回 "No active session found" 错误，因为 OpenClaw 已将该 process session 标记为 `failed`

1.4 WHEN bridge 吸收 SIGTERM 后 THEN bridge 没有输出任何 FIFO 控制通道信息（`control_channel` 事件），agent 无法知道如何通过备用路径控制 bridge

### Expected Behavior (Correct)

2.1 WHEN bridge 吸收 SIGTERM（进入 `deferred: true` 路径） THEN bridge SHALL 立即调用 `setupFifoControl()` 建立 FIFO 备用控制通道（路径：`/tmp/kiro-acp-bridge-${process.pid}.fifo`），确保 bridge 在 stdio session 失效后仍可被控制

2.2 WHEN bridge 在 SIGTERM 吸收路径中建立 FIFO 备用通道后 THEN bridge SHALL 输出 `control_channel` 事件（`{"type":"control_channel","mode":"fifo","path":"/tmp/kiro-acp-bridge-PID.fifo","reason":"sigterm_recovery"}`），通知 agent FIFO 路径

2.3 WHEN bridge 已通过 SIGTERM 吸收路径建立了 FIFO 备用通道后 stdin 触发 EOF THEN bridge SHALL 不重复创建 FIFO（因为已经存在），避免冲突

2.4 WHEN agent 在 process session 失败后需要继续控制 bridge THEN agent SHALL 能够通过 FIFO 路径（从 bridge stdout 日志中的 `control_channel` 事件获取，或通过 `/tmp/kiro-acp-bridge-PID.fifo` 约定路径推断）向 bridge 发送 JSONL 命令

### Unchanged Behavior (Regression Prevention)

3.1 WHEN bridge 以 stdio 模式正常运行（未收到 SIGTERM） THEN bridge SHALL CONTINUE TO 通过 stdin 接收命令，不主动创建 FIFO

3.2 WHEN bridge 的 stdin 收到 EOF（正常的 pipe 关闭） THEN bridge SHALL CONTINUE TO 通过现有的 `rl.on('close', ...)` 机制自动创建 FIFO fallback 通道

3.3 WHEN bridge 收到 SIGTERM 且没有活跃 session（`!acpReady || !currentSessionId`） THEN bridge SHALL CONTINUE TO 立即执行 graceful shutdown，不建立 FIFO（因为 bridge 即将退出）

3.4 WHEN bridge 以 `--control fifo` 模式启动 THEN bridge SHALL CONTINUE TO 使用启动时指定的 FIFO 路径，SIGTERM 吸收路径不重复创建 FIFO

3.5 WHEN bridge 吸收第一次 SIGTERM 后收到第二次 SIGTERM THEN bridge SHALL CONTINUE TO 执行 graceful shutdown（sigterm-resilience 的现有行为不变）

3.6 WHEN bridge 吸收第一次 SIGTERM 后超过 60 秒未收到第二次 SIGTERM THEN bridge SHALL CONTINUE TO 自动执行 graceful shutdown（60 秒超时机制不变）

3.7 WHEN 用户通过控制通道（stdin 或 FIFO）发送有效的 JSONL 命令 THEN bridge SHALL CONTINUE TO 正确解析并执行对应操作，返回正确的事件响应

3.8 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件，保持 keepalive 机制

3.9 WHEN bridge 执行 graceful shutdown 时清理 FIFO 文件 THEN bridge SHALL CONTINUE TO 删除 FIFO 文件（包括 SIGTERM 吸收路径创建的 FIFO）
