# Bugfix Requirements Document

## Introduction

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 第 5 次实测中，bridge 在 `session_new` 成功后直接走了 `shutdown(SIGTERM)` 而不是 `deferred: true`。与第 4 次测试（成功吸收）交替出现。这是本系列第 7 个 bugfix（session-routing → process-stability → control-channel → signal-isolation → sigterm-resilience → session-recovery → sigterm-absorption-scope）。

根因：当前 SIGTERM 吸收条件过严。条件为：
```javascript
reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0
```

其中 `currentSessionId` 和 `pending.size === 0` 两个子条件导致了竞态失败：

- **路径 A（成功吸收）**：SIGTERM 在 `session_new` RPC 完成之后到达，`currentSessionId` 有值且 `pending.size === 0` → 吸收条件满足 → `deferred: true`
- **路径 B（直接 shutdown）**：SIGTERM 在 `session_new` RPC 还在 pending 时到达，`pending.size > 0`（RPC 在 Map 里）或 `currentSessionId === null`（还没被赋值）→ 吸收条件不满足 → grace period → shutdown

两种死法交替出现取决于 SIGTERM 到达的精确时刻。真正的不变量是：**ACP 进程已初始化（`acpReady`）时，第一次 SIGTERM 就应该被吸收**，不论 session 状态或 pending RPC 数量。

修复方向：将吸收条件放宽为 `reason === 'SIGTERM' && acpReady && sigTermCount === 0`。这是一行条件修改。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 收到 SIGTERM 且 `session_new` RPC 还在 pending（`pending.size > 0`，RPC 在 Map 中尚未 resolve） THEN 吸收条件中的 `pending.size === 0` 不满足，bridge 跳过吸收逻辑，进入 grace period → shutdown，`session_new` 的结果被丢弃

1.2 WHEN bridge 收到 SIGTERM 且 `createSession()` 中的 `await rpc('session/new', ...)` 还没 resolve（`currentSessionId === null`，尚未被赋值） THEN 吸收条件中的 `currentSessionId` 为 falsy，bridge 跳过吸收逻辑，直接执行 shutdown

1.3 WHEN bridge 收到 SIGTERM 的时机恰好在 `session_new` RPC resolve 之后、`currentSessionId` 赋值之后 THEN 吸收条件全部满足，`deferred: true` 成功吸收——但这取决于 SIGTERM 到达的精确时刻，导致第 4 次和第 5 次实测结果交替出现

### Expected Behavior (Correct)

2.1 WHEN bridge 收到第一次 SIGTERM 且 `acpReady === true`（ACP 进程已初始化） THEN bridge SHALL 吸收此 SIGTERM——无论 `currentSessionId` 是否有值、无论 `pending.size` 是否为 0——输出 `bridge_signal_received` 事件含 `deferred: true`，bridge 继续正常运行

2.2 WHEN bridge 收到第一次 SIGTERM 且 `acpReady === true` 且有 pending RPC（如 `session_new` 正在进行） THEN bridge SHALL 吸收此 SIGTERM 并让 pending RPC 自然完成，而不是走 grace period → shutdown 路径

2.3 WHEN bridge 收到第一次 SIGTERM 且 `acpReady === true` 且 `currentSessionId === null`（session 尚未建立或正在建立中） THEN bridge SHALL 吸收此 SIGTERM，保护正在进行的 session 建立流程

### Unchanged Behavior (Regression Prevention)

3.1 WHEN bridge 收到 SIGTERM 且 `acpReady === false`（ACP 进程尚未初始化完成） THEN bridge SHALL CONTINUE TO 立即执行 graceful shutdown，不吸收（bridge 还没开始工作，没必要保护）

3.2 WHEN bridge 收到 SIGINT（用户 Ctrl+C） THEN bridge SHALL CONTINUE TO 立即执行 graceful shutdown，不吸收（SIGINT 是用户明确的终止意图）

3.3 WHEN 用户通过控制通道发送 `{"op":"stop"}` 命令 THEN bridge SHALL CONTINUE TO 立即终止 ACP 子进程并关闭，不受 SIGTERM 吸收机制影响

3.4 WHEN bridge 已吸收第一次 SIGTERM 后收到第二次 SIGTERM THEN bridge SHALL CONTINUE TO 立即执行 graceful shutdown（`sigTermCount > 0` 条件不满足吸收）

3.5 WHEN bridge 已吸收第一次 SIGTERM 后超过 60 秒未收到第二次 SIGTERM THEN bridge SHALL CONTINUE TO 自动执行 graceful shutdown（60 秒超时机制不变）

3.6 WHEN bridge 吸收 SIGTERM 后（stdio 模式） THEN bridge SHALL CONTINUE TO 建立 FIFO 备用控制通道（bugfix #6 session-recovery 的行为不变）

3.7 WHEN 用户通过控制通道（stdin 或 FIFO）发送有效的 JSONL 命令（start、session_new、send、reply、cancel、ping 等） THEN bridge SHALL CONTINUE TO 正确解析并执行对应操作，返回正确的事件响应

3.8 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件，保持 keepalive 机制

3.9 WHEN `bridge_signal_received` 事件输出时 THEN bridge SHALL CONTINUE TO 包含 `signal`、`pendingCalls`、`timestamp`、`deferred` 字段，事件格式不变
