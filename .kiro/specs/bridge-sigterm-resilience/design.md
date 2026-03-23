# Bridge SIGTERM Resilience Bugfix Design

## Overview

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 实测中，`session_new` 成功后 1-3 秒内被宿主进程管理器发送的 SIGTERM 杀死。此时 `pending.size === 0`（无 in-flight RPC），前一个 bugfix（signal-isolation）的 grace period 条件不满足，bridge 立即执行 shutdown 并主动杀死 ACP 子进程。这是本系列第 5 个 bugfix。

修复策略：
1. **SIGTERM 吸收机制**：有活跃 session 且无 pending RPC 时，第一次 SIGTERM 被"吸收"而非立即 shutdown；第二次 SIGTERM 或 60 秒超时后执行真正的 shutdown
2. **启动方式改造**：SKILL.md 启动命令添加 `setsid`，使 bridge 脱离宿主进程组

## Glossary

- **Bug_Condition (C)**: bridge 收到 SIGTERM 时有活跃 session（`acpReady && currentSessionId`）但 `pending.size === 0`，导致 bridge 立即 shutdown 而非保护正在使用的 session
- **Property (P)**: 有活跃 session 时第一次 SIGTERM 被吸收，bridge 继续运行；第二次 SIGTERM 或 60 秒超时后才执行 shutdown
- **Preservation**: 无活跃 session 时 SIGTERM 立即 shutdown、`op:stop` 立即终止、有 pending RPC 时走 grace period、所有 JSONL 命令处理不变
- **sigTermCount**: 新增计数器，记录收到的 SIGTERM 次数
- **firstSigTermTime**: 新增时间戳，记录第一次被吸收的 SIGTERM 时间
- **deferred**: `bridge_signal_received` 事件新增字段，`true` 表示此 SIGTERM 被吸收而非执行 shutdown
- **gracefulShutdown()**: `scripts/kiro-acp-bridge.js` 中处理 SIGTERM/SIGINT 的函数，是本次修改的核心入口

## Bug Details

### Bug Condition

Bug 在以下场景触发：bridge 通过 OpenClaw `bash background:true` 启动后，完成 `session_new` 建立活跃 session，但用户还没来得及发送 `send` 命令。此时宿主进程管理器（PTY / background session 生命周期管理）向 bridge 发送 SIGTERM。由于 `pending.size === 0`，signal-isolation 的 grace period 不生效，bridge 立即执行 `gracefulShutdown('SIGTERM')`，主动 kill ACP 并退出。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { signal: string, acpReady: boolean, currentSessionId: string|null, pendingSize: number }
  OUTPUT: boolean

  RETURN input.signal == 'SIGTERM'
         AND input.acpReady == true
         AND input.currentSessionId != null
         AND input.pendingSize == 0
         AND sigTermCount == 0
END FUNCTION
```

### Examples

- **典型场景**: bridge 启动 → `start` ACP → `session_new` 成功（currentSessionId='sess_abc'）→ 1 秒后宿主发 SIGTERM → bridge 立即 shutdown → ACP 被 kill → 用户还没发任何 prompt（期望：SIGTERM 被吸收，bridge 继续运行等待用户操作）
- **第二次 SIGTERM**: bridge 吸收第一次 SIGTERM → 10 秒后宿主再发 SIGTERM → bridge 执行 graceful shutdown（期望：第二次 SIGTERM 触发真正的 shutdown）
- **60 秒超时**: bridge 吸收第一次 SIGTERM → 60 秒内无第二次 SIGTERM → bridge 自动 shutdown（期望：不会永远挂起）
- **无活跃 session**: bridge 启动但未 start ACP → 收到 SIGTERM → 立即 shutdown（期望：行为不变，不吸收）
- **有 pending RPC**: bridge 正在执行 `session/prompt`（pending.size > 0）→ 收到 SIGTERM → 走 grace period 逻辑（期望：不走吸收逻辑，走现有 grace period）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `{"op":"stop"}` 命令立即终止 ACP 子进程并关闭 bridge，不受 SIGTERM 吸收机制影响（`stopBridge()` 不经过 `gracefulShutdown()`）
- 无活跃 session 时（`!acpReady || !currentSessionId`）SIGTERM 立即执行 graceful shutdown，行为与修复前完全一致
- 有 pending RPC 时（`pending.size > 0`）SIGTERM 走现有 grace period 逻辑（等待 pending 完成或 30 秒超时），不走吸收逻辑
- 所有 JSONL 命令（start、session_new、send、reply、cancel、ping 等）处理和响应格式不变
- 心跳事件、FIFO 控制通道、keepalive 机制不变
- `bridge_signal_received` 事件保留现有字段（`signal`、`pendingCalls`、`timestamp`），新增 `deferred` 字段
- SIGINT 行为不变——SIGINT 始终立即 shutdown（用户 Ctrl+C 是明确的终止意图）

**Scope:**
所有不涉及 SIGTERM 信号处理入口逻辑的行为应完全不受此修复影响。吸收机制仅在 `gracefulShutdown()` 入口处新增条件判断，不修改 shutdown 执行逻辑本身。

## Hypothesized Root Cause

基于 bug report 和代码分析，根因如下：

1. **`gracefulShutdown()` 无条件执行 shutdown**: 当前代码收到 SIGTERM 后，`gracefulShutdown('SIGTERM')` 检查 `shuttingDown` 防重入后直接执行 shutdown 流程。没有区分"有活跃 session 但无 pending RPC"和"无活跃 session"两种场景。前者应该被保护（吸收 SIGTERM），后者才应该立即 shutdown。

2. **grace period 条件过窄**: signal-isolation 添加的 grace period 只在 `pending.size > 0` 时生效。但实际场景中，`session_new` 刚完成、用户还没发 `send` 时 `pending.size === 0`，grace period 不触发，bridge 立即 shutdown。需要一个更宽泛的保护机制。

3. **宿主进程组信号传播**: 虽然 signal-isolation 已添加 `detached: true` 隔离 ACP 子进程，但 bridge 本身仍在宿主进程组中。宿主的 PTY / background session 管理可能在 bridge 启动后短时间内发送 SIGTERM。SKILL.md 启动命令缺少 `setsid`，bridge 无法脱离宿主进程组。

4. **无法区分"宿主误杀"和"用户有意终止"**: 当前 bridge 对所有 SIGTERM 一视同仁。但在实际使用中，宿主误杀（进程管理生命周期）和用户有意终止（`op:stop` 或手动 kill）是不同的。用户有意终止通过 `op:stop` 走 `stopBridge()` 路径，不经过 `gracefulShutdown()`。因此 `gracefulShutdown()` 收到的 SIGTERM 更可能是宿主误杀，应该被保护。

## Correctness Properties

Property 1: Bug Condition - 有活跃 session 时第一次 SIGTERM 被吸收

_For any_ bridge 状态满足 `acpReady === true && currentSessionId !== null && pending.size === 0` 时收到第一次 SIGTERM，修复后的 `gracefulShutdown()` SHALL 吸收此 SIGTERM（不执行 shutdown），输出 `bridge_signal_received` 事件含 `deferred: true`，bridge 继续正常运行。

**Validates: Requirements 2.1, 2.5**

Property 2: Preservation - 无活跃 session 时 SIGTERM 立即 shutdown

_For any_ bridge 状态满足 `!acpReady || !currentSessionId` 时收到 SIGTERM，修复后的 bridge SHALL 产生与修复前完全相同的行为——立即执行 graceful shutdown，输出 `shutdown` 事件，bridge 退出。

**Validates: Requirements 3.1, 3.2, 3.6**

## Fix Implementation

### Changes Required

假设根因分析正确，修改集中在两个文件：

**File**: `scripts/kiro-acp-bridge.js`

**Function**: `gracefulShutdown()`

**Specific Changes**:

1. **新增状态变量**:
   - `let sigTermCount = 0;` — 记录收到的 SIGTERM 次数
   - `let firstSigTermTime = null;` — 记录第一次被吸收的 SIGTERM 时间戳
   - `let sigTermTimeoutTimer = null;` — 60 秒超时 timer

2. **修改 `gracefulShutdown()` 入口逻辑**:
   - 在现有 `if (shuttingDown) return;` 之后、`shuttingDown = true;` 之前，新增吸收判断
   - 条件：`reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0`
   - 满足条件时：递增 `sigTermCount`，记录 `firstSigTermTime`，输出 `bridge_signal_received` 含 `deferred: true`，启动 60 秒超时 timer，**return 不执行 shutdown**
   - 不满足条件时（包括第二次 SIGTERM、SIGINT、无活跃 session、有 pending RPC）：继续执行现有 shutdown 逻辑

   ```javascript
   async function gracefulShutdown(reason) {
     if (shuttingDown) return;

     // SIGTERM 吸收机制：有活跃 session 且无 pending RPC 时，吸收第一次 SIGTERM
     if (reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0) {
       sigTermCount++;
       firstSigTermTime = Date.now();
       emit({
         type: 'bridge_signal_received',
         signal: reason,
         pendingCalls: pending.size,
         timestamp: new Date().toISOString(),
         deferred: true,
       });
       // 60 秒超时后自动 shutdown
       sigTermTimeoutTimer = setTimeout(() => {
         emit({ type: 'info', message: 'SIGTERM absorption timeout (60s), executing shutdown' });
         sigTermCount++; // 防止再次吸收
         gracefulShutdown('SIGTERM_TIMEOUT');
       }, 60_000);
       return; // 吸收，不执行 shutdown
     }

     shuttingDown = true;
     if (sigTermTimeoutTimer) { clearTimeout(sigTermTimeoutTimer); sigTermTimeoutTimer = null; }

     // ... 以下为现有 shutdown 逻辑，不变 ...
   }
   ```

3. **修改 SIGTERM handler 注册**:
   - 当前：`process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));`
   - 不需要修改——`gracefulShutdown()` 内部已处理吸收逻辑，第二次 SIGTERM 时 `sigTermCount > 0` 条件不满足，直接走 shutdown

4. **SIGINT 不受影响**:
   - `process.on('SIGINT', () => gracefulShutdown('SIGINT'));`
   - `reason === 'SIGTERM'` 条件确保 SIGINT 始终立即 shutdown

**File**: `SKILL.md`

**Specific Changes**:

5. **启动命令添加 `setsid`**:
   - 将所有 `bash background:true command:"node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js"` 改为 `bash background:true command:"setsid node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js"`
   - `setsid` 使 bridge 进程获得新的 session 和进程组，脱离宿主进程组

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 存在（有活跃 session 时 SIGTERM 导致立即 shutdown），再在修复后验证吸收机制正确性和现有行为保持。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认有活跃 session 时 SIGTERM 导致 bridge 立即 shutdown。

**Test Plan**: 编写测试脚本模拟 bridge 有活跃 session 的状态（通过 ping 确认 bridge 运行后发送 SIGTERM），验证 bridge 立即退出。由于无法启动真实 ACP，测试聚焦于代码静态检查和无 session 场景的行为对比。

**Test Cases**:
1. **无 session 时 SIGTERM 立即退出**: 启动 bridge → 发送 SIGTERM → 验证 bridge 退出且输出 shutdown 事件（will pass on unfixed code — 确认基线行为）
2. **代码检查：gracefulShutdown 无吸收逻辑**: 读取 bridge 源码 → 验证 `gracefulShutdown()` 中没有 `sigTermCount` 或 `deferred` 相关逻辑（will fail on unfixed code — 确认缺少吸收机制）
3. **代码检查：SKILL.md 无 setsid**: 读取 SKILL.md → 验证启动命令不包含 `setsid`（will fail on unfixed code — 确认缺少进程组隔离）

**Expected Counterexamples**:
- `gracefulShutdown()` 中无条件执行 `shuttingDown = true` 后进入 shutdown 流程
- 没有 `sigTermCount`、`firstSigTermTime`、`deferred` 等吸收相关变量和逻辑

### Fix Checking

**Goal**: 验证修复后，有活跃 session 时第一次 SIGTERM 被吸收，第二次 SIGTERM 或超时后执行 shutdown。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  bridge := start_bridge()
  // 模拟有活跃 session 的状态
  ASSERT bridge_has_active_session(bridge)
  
  send_sigterm(bridge)
  ASSERT bridge_still_running(bridge)
  ASSERT bridge_emitted_event({ type: 'bridge_signal_received', deferred: true })
  
  send_sigterm(bridge)  // 第二次
  ASSERT bridge_exits_with_shutdown(bridge)
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，无活跃 session 时 SIGTERM 立即 shutdown、`op:stop` 立即终止、所有命令处理不变。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可以自动生成大量 JSONL 命令组合验证命令处理不变
- 能覆盖 `op:stop` 立即终止、ping/pong 响应格式等边界情况
- 对所有非 SIGTERM-with-active-session 输入提供强保证

**Test Plan**: 复用现有 6 个测试套件验证所有现有行为不变，新增针对吸收机制的测试。

**Test Cases**:
1. **无 session 时 SIGTERM 立即 shutdown**: 验证 bridge 无活跃 session 时收到 SIGTERM 仍立即退出（现有 test-signal-preservation.js Test 7）
2. **op:stop 立即终止**: 验证 `{"op":"stop"}` 仍立即 kill ACP（现有 test-signal-preservation.js Test 2）
3. **ping/pong 响应格式**: 验证 ping 命令响应格式不变（现有 test-signal-preservation.js Test 1）
4. **JSONL 命令处理**: 验证 unknown op、invalid JSON、send without ACP 等错误处理不变（现有 test-signal-preservation.js Tests 3-5）
5. **bridge_signal_received 事件格式**: 验证现有字段保留，新增 `deferred` 字段（现有 test-signal-bug-condition.js 需适配）
6. **SIGINT 立即 shutdown**: 验证 SIGINT 不受吸收机制影响，始终立即 shutdown

### Unit Tests

- 测试 `gracefulShutdown('SIGTERM')` 在 `acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0` 时返回而不执行 shutdown
- 测试 `gracefulShutdown('SIGTERM')` 在 `sigTermCount > 0` 时执行 shutdown
- 测试 `gracefulShutdown('SIGINT')` 始终执行 shutdown（不吸收）
- 测试 `gracefulShutdown('SIGTERM')` 在 `!acpReady` 时立即 shutdown
- 测试 `gracefulShutdown('SIGTERM')` 在 `pending.size > 0` 时走 grace period（不吸收）
- 测试 60 秒超时 timer 触发 shutdown
- 测试 `bridge_signal_received` 事件在吸收时包含 `deferred: true`
- 测试 SKILL.md 启动命令包含 `setsid`

### Property-Based Tests

- 生成随机 bridge 状态组合（acpReady: true/false, currentSessionId: null/string, pending.size: 0-5, sigTermCount: 0-2），验证吸收条件判断正确：仅在 `acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0 && reason === 'SIGTERM'` 时吸收
- 生成随机 JSONL 命令序列，验证修复后命令处理响应与修复前一致（preservation）
- 生成随机信号序列（SIGTERM × N, SIGINT），验证吸收计数和 shutdown 触发时机正确

### Integration Tests

- 完整吸收流程测试：启动 bridge → ping 确认运行 → SIGTERM → 验证 bridge 仍运行（deferred 事件）→ 第二次 SIGTERM → 验证 shutdown
- 超时测试：启动 bridge → SIGTERM（吸收）→ 等待 60 秒 → 验证自动 shutdown
- op:stop 不受影响测试：启动 bridge → SIGTERM（吸收）→ `{"op":"stop"}` → 验证立即终止
- 现有测试套件全部通过：test-signal-preservation.js、test-signal-bug-condition.js、test-fifo-preservation.js、test-fifo-bug-condition.js、test-preservation-properties.js、test-bug-condition-exploration.js
