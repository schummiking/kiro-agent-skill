# Bugfix Requirements Document

## Introduction

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 的实际使用中，当宿主侧进程管理器向进程组发送 SIGTERM 时，bridge 和 ACP 子进程同时被杀死，导致正在执行的 `session/prompt` 中断。这是本系列第 4 个 bugfix（session-routing → process-stability → control-channel → signal-isolation），前三个修复分别解决了会话路由、进程存活和控制通道问题，本次解决信号隔离问题。

实际故障时间线：bridge 启动 → ACP 初始化 → session 创建 → send 发出 prompt → 3-8 秒后宿主发送 SIGTERM → bridge 和 ACP 同时收到信号 → ACP 在 `session/prompt` 执行中被终止 → `ACP exited before response (method=session/prompt, code=null, signal=SIGTERM)`。

根因有两个：(1) `spawn()` 未设置 `detached: true`，bridge 和 ACP 在同一进程组，进程组级 SIGTERM 同时杀死两者；(2) `gracefulShutdown()` 收到 SIGTERM 后立即 `acp.kill('SIGTERM')`，不等待 in-flight RPC 完成。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN 宿主侧进程管理器向 bridge 所在进程组发送 SIGTERM（如 `kill(-pgid, SIGTERM)`）且 ACP 子进程有 in-flight `session/prompt` THEN ACP 子进程直接收到 SIGTERM 被终止，bridge 日志显示 `ACP exited before response (method=session/prompt, code=null, signal=SIGTERM)`，用户的 prompt 执行被中断且无法恢复

1.2 WHEN bridge 收到 SIGTERM 信号且存在 pending RPC 调用（in-flight prompt） THEN `gracefulShutdown()` 立即调用 `acp.kill('SIGTERM')` 终止 ACP 子进程，不等待 pending RPC 完成，导致正在执行的 prompt 被强制中断

1.3 WHEN ACP 子进程因外部信号（进程组传播）被终止 THEN bridge 日志仅输出 `{"type":"shutdown","reason":"SIGTERM"}` 和 `{"type":"exit","code":null,"signal":"SIGTERM"}`，无法区分 ACP 是被 bridge 主动终止、被外部信号直接杀死、还是自行退出——缺少信号来源的可观测性

1.4 WHEN bridge 和 ACP 在同一进程组中运行且宿主发送进程组级信号 THEN 两个进程同时收到信号，bridge 的 graceful shutdown 逻辑来不及保护 ACP 子进程，信号处理存在竞态条件

### Expected Behavior (Correct)

2.1 WHEN ACP 子进程通过 `spawn()` 启动 THEN bridge SHALL 使用 `detached: true` 选项使 ACP 子进程获得独立的进程组，防止宿主侧进程组级信号直接传播到 ACP 子进程

2.2 WHEN bridge 收到 SIGTERM/SIGINT 信号且存在 pending RPC 调用（in-flight prompt） THEN bridge SHALL 等待 pending RPC 完成（设置合理超时，如 30 秒）后再终止 ACP 子进程，而非立即 kill

2.3 WHEN bridge 收到 SIGTERM/SIGINT 信号且无 pending RPC 调用 THEN bridge SHALL 立即执行 graceful shutdown（与当前行为一致），不引入不必要的延迟

2.4 WHEN bridge 收到信号时 SHALL 输出 `{"type":"bridge_signal_received","signal":"SIGTERM","pendingCalls":<count>,"timestamp":<iso>}` 结构化事件，明确记录信号接收时刻和当时的 pending 状态

2.5 WHEN ACP 子进程退出时 bridge SHALL 在 exit 事件中包含 `terminatedBy` 字段，区分 `"bridge"`（bridge 主动 kill）、`"external"`（外部信号直接杀死）、`"self"`（ACP 自行退出）三种来源

2.6 WHEN bridge 等待 pending RPC 完成的超时到期（30 秒） THEN bridge SHALL 强制终止 ACP 子进程并在日志中记录超时信息，确保 bridge 最终能退出

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户通过控制通道（stdin 或 FIFO）发送有效的 JSONL 命令（start、session_new、send、reply、cancel、stop、ping 等） THEN bridge SHALL CONTINUE TO 正确解析并执行对应的 ACP 操作，返回正确的事件响应

3.2 WHEN ACP 子进程正常完成 prompt 后退出（无 in-flight RPC） THEN bridge SHALL CONTINUE TO 发送 `exit` 事件、清理 pending promises、保存状态、通知用户

3.3 WHEN 用户发送 `{"op":"stop"}` 命令 THEN bridge SHALL CONTINUE TO 向 ACP 子进程发送 SIGTERM 并正常关闭

3.4 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件，保持 keepalive 机制

3.5 WHEN ACP 子进程发送 `session/update` 通知或 `session/request_permission` 请求 THEN bridge SHALL CONTINUE TO 正确处理并转发事件，自动权限处理策略不变

3.6 WHEN bridge 以 `--control fifo` 模式运行 THEN bridge SHALL CONTINUE TO 通过 FIFO 控制通道接收命令，EOF 重连机制不变

3.7 WHEN 用户发送 `{"op":"ping"}` 命令 THEN bridge SHALL CONTINUE TO 返回包含 pid、ready、session 信息的 pong 响应
