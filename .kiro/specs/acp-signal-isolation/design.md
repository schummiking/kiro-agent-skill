# ACP Signal Isolation Bugfix Design

## Overview

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 实际使用中，宿主侧进程管理器向进程组发送 SIGTERM 时，bridge 和 ACP 子进程同时被杀死，导致正在执行的 `session/prompt` 中断。这是本系列第 4 个 bugfix。

修复策略包含三个方面：
1. **进程组隔离**：`spawn()` 添加 `detached: true`，使 ACP 子进程获得独立进程组，防止进程组级信号传播
2. **SIGTERM grace period**：bridge 收到 SIGTERM 时，若存在 in-flight RPC，等待 pending 完成（30 秒超时）后再终止 ACP
3. **信号可观测性**：新增 `bridge_signal_received` 事件，exit 事件增加 `terminatedBy` 字段区分终止来源

## Glossary

- **Bug_Condition (C)**: 宿主向 bridge 所在进程组发送 SIGTERM 时，ACP 子进程因同属一个进程组而被直接杀死；或 bridge 收到 SIGTERM 后立即 kill ACP 不等待 in-flight RPC
- **Property (P)**: ACP 子进程不受进程组级信号影响，bridge 收到 SIGTERM 时等待 pending RPC 完成后再优雅终止 ACP
- **Preservation**: 现有控制通道命令处理、心跳、FIFO、ping/pong、`op:stop` 立即终止等行为必须保持不变
- **bridge**: `scripts/kiro-acp-bridge.js`，OpenClaw 与 Kiro ACP 之间的传输层
- **ACP 子进程**: 由 bridge 通过 `spawn('kiro-cli', ['acp', ...])` 启动的 Kiro CLI ACP 进程
- **pending**: `Map<id, {resolve, reject, method, ts, params}>`，存储等待 ACP 响应的 in-flight RPC 调用
- **进程组 (pgid)**: Unix 进程组，`kill(-pgid, SIGTERM)` 会向组内所有进程发送信号
- **detached**: `spawn()` 选项，使子进程获得独立的进程组（新 pgid = 子进程 pid）
- **terminatedBy**: exit 事件新增字段，区分 `"bridge"`（bridge 主动 kill）、`"external"`（外部信号直接杀死）、`"self"`（ACP 自行退出）

## Bug Details

### Bug Condition

Bug 在两种场景中触发：(1) `spawn()` 未设置 `detached: true`，bridge 和 ACP 在同一进程组，宿主发送 `kill(-pgid, SIGTERM)` 时两者同时被杀死，ACP 在 `session/prompt` 执行中被终止；(2) `gracefulShutdown()` 收到 SIGTERM 后立即 `acp.kill('SIGTERM')`，不等待 in-flight RPC 完成，即使 ACP 没有被进程组信号直接杀死，bridge 也会主动中断它。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { signalTarget: string, pendingCount: number, acpState: string }
  OUTPUT: boolean

  // 场景 1: 进程组级信号传播到 ACP
  IF input.signalTarget == 'process_group'
     AND acpProcessGroupId == bridgeProcessGroupId
     AND input.acpState == 'running_with_inflight_rpc'
    RETURN true

  // 场景 2: bridge 收到 SIGTERM 后立即 kill ACP，不等待 pending
  IF input.signalTarget == 'bridge_only'
     AND input.pendingCount > 0
     AND gracefulShutdownKillsImmediately == true
    RETURN true

  RETURN false
END FUNCTION
```

### Examples

- **进程组信号传播**: bridge(pid=1000, pgid=1000) spawn ACP(pid=1001, pgid=1000) → 宿主 `kill(-1000, SIGTERM)` → ACP 直接收到 SIGTERM 被终止 → `ACP exited before response (method=session/prompt, code=null, signal=SIGTERM)`（期望：ACP pgid=1001，不受进程组信号影响）
- **立即 kill 不等待**: bridge 收到 SIGTERM → `gracefulShutdown('SIGTERM')` → 立即 `acp.kill('SIGTERM')` → ACP 在 `session/prompt` 执行中被终止（期望：等待 pending RPC 完成或 30 秒超时后再终止）
- **无 pending 时正常 shutdown**: bridge 收到 SIGTERM → `pending.size === 0` → 立即 shutdown（期望：行为不变，无延迟）
- **超时强制终止**: bridge 收到 SIGTERM → 等待 pending → 30 秒超时 → 强制 SIGKILL ACP（期望：bridge 最终能退出）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- 通过控制通道（stdin 或 FIFO）发送的所有 JSONL 命令（start、session_new、send、reply、cancel、stop、ping 等）必须继续正确解析和执行
- ACP 子进程正常完成 prompt 后退出时的 exit 事件、pending 清理、状态保存、用户通知必须保持不变
- `{"op":"stop"}` 命令必须继续立即向 ACP 发送 SIGTERM 并正常关闭（用户主动停止是有意为之，不受 grace period 影响）
- 心跳事件定期输出、keepalive 机制不变
- `session/update` 通知和 `session/request_permission` 请求的处理和转发不变
- FIFO 控制通道模式（`--control fifo`）行为不变，EOF 重连机制不变
- `ping` 命令返回包含 pid、ready、session 信息的 pong 响应不变

**Scope:**
所有不涉及 ACP 子进程 spawn 选项、SIGTERM/SIGINT 信号处理、exit 事件格式的行为应完全不受此修复影响。包括：
- 正常的 JSONL 命令输入和响应
- ACP JSON-RPC 通信（initialize、session/new、session/prompt 等）
- 状态文件读写
- 用户通知（openclaw system event）
- 控制通道初始化和命令分发

## Hypothesized Root Cause

基于 bug report 和代码分析，根因如下：

1. **`spawn()` 缺少 `detached: true`**: 当前 `startAcp()` 中 `spawn('kiro-cli', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, cwd: process.cwd() })` 未设置 `detached: true`。默认情况下子进程继承父进程的进程组，宿主发送 `kill(-pgid, SIGTERM)` 时 bridge 和 ACP 同时收到信号。ACP 没有自己的 SIGTERM handler，直接被终止。

2. **`gracefulShutdown()` 不等待 pending RPC**: 当前 `gracefulShutdown()` 收到 SIGTERM 后立即执行 `acp.kill('SIGTERM')`，5 秒后 SIGKILL。没有检查 `pending.size`，不等待 in-flight RPC 完成。即使 ACP 通过 `detached: true` 避免了进程组信号，bridge 仍会主动中断它。

3. **exit 事件缺少终止来源信息**: 当前 `acp.on('exit', ...)` handler 只输出 `code` 和 `signal`，无法区分 ACP 是被 bridge 主动 kill、被外部信号直接杀死、还是自行退出。这导致故障排查困难。

4. **缺少信号接收事件**: 当前 `gracefulShutdown()` 只输出 `{"type":"shutdown","reason":"SIGTERM"}`，没有记录信号接收时刻的 pending 状态，无法判断信号到达时是否有 in-flight RPC。

## Correctness Properties

Property 1: Bug Condition - ACP 子进程进程组隔离

_For any_ bridge 通过 `startAcp()` 启动 ACP 子进程的情况下，ACP 子进程 SHALL 运行在独立的进程组中（pgid ≠ bridge pgid），使得向 bridge 进程组发送的信号不会传播到 ACP 子进程。

**Validates: Requirements 2.1**

Property 2: Bug Condition - SIGTERM grace period 等待 pending RPC

_For any_ bridge 收到 SIGTERM/SIGINT 信号且 `pending.size > 0` 的情况下，bridge SHALL 等待所有 pending RPC 完成（或 30 秒超时到期）后再终止 ACP 子进程，而非立即 kill。

**Validates: Requirements 2.2, 2.6**

Property 3: Preservation - 命令处理和现有行为不变

_For any_ 通过控制通道发送的合法 JSONL 命令（start、session_new、send、reply、cancel、stop、ping 等），修复后的 bridge SHALL 产生与修复前完全相同的命令处理行为，保持所有现有功能不变。特别是 `op:stop` 命令仍立即终止 ACP，不受 grace period 影响。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

假设根因分析正确，所有修改集中在 `scripts/kiro-acp-bridge.js` 一个文件：

**File**: `scripts/kiro-acp-bridge.js`

**Function**: `startAcp()`、`gracefulShutdown()`、`acp.on('exit')` handler

**Specific Changes**:

1. **`startAcp()` 添加 `detached: true`**:
   - 在 `spawn('kiro-cli', args, { ... })` 的 options 中添加 `detached: true`
   - 不调用 `acp.unref()`——bridge 仍需跟踪 ACP 生命周期（exit 事件、pending 清理等）
   - `detached: true` 使 ACP 获得独立进程组（pgid = ACP pid），进程组级 SIGTERM 不再传播

   ```javascript
   acp = spawn('kiro-cli', args, {
     stdio: ['pipe', 'pipe', 'pipe'],
     env: process.env,
     cwd: process.cwd(),
     detached: true,  // ACP 获得独立进程组
   });
   ```

2. **`gracefulShutdown()` 添加 pending RPC grace period**:
   - 收到 SIGTERM/SIGINT 时，先输出 `bridge_signal_received` 事件
   - 检查 `pending.size`：若 > 0，等待 pending 全部完成或 30 秒超时
   - 等待期间监听 pending Map 变化（每秒检查一次）
   - 超时后输出超时警告，强制终止 ACP
   - 若 `pending.size === 0`，立即执行 shutdown（无延迟）

   ```javascript
   async function gracefulShutdown(reason) {
     if (shuttingDown) return;
     shuttingDown = true;

     clearInterval(heartbeatTimer);

     // 信号可观测性事件
     emit({
       type: 'bridge_signal_received',
       signal: reason,
       pendingCalls: pending.size,
       timestamp: new Date().toISOString(),
     });

     // Grace period: 等待 pending RPC 完成
     if (pending.size > 0) {
       const GRACE_TIMEOUT_MS = 30_000;
       await Promise.race([
         new Promise(resolve => {
           const check = setInterval(() => {
             if (pending.size === 0) { clearInterval(check); resolve(); }
           }, 1000);
         }),
         new Promise(resolve => setTimeout(() => {
           emit({ type: 'info', message: `Grace period timeout (${GRACE_TIMEOUT_MS}ms), forcing shutdown` });
           resolve();
         }, GRACE_TIMEOUT_MS)),
       ]);
     }

     // FIFO 清理
     if (controlMode === 'fifo' && controlPath) {
       try { fs.unlinkSync(controlPath); } catch {}
     }

     emit({ type: 'shutdown', reason, session: currentSessionId, pid: acp?.pid || null });

     // 标记 bridge 主动终止，供 exit handler 使用
     bridgeInitiatedKill = true;

     if (acp && !acp.killed) {
       acp.kill('SIGTERM');
       await Promise.race([
         new Promise(resolve => acp.on('exit', resolve)),
         new Promise(resolve => setTimeout(resolve, 5000)),
       ]);
       if (!acp.killed) acp.kill('SIGKILL');
     }

     saveState();
     notifyUser(`Bridge shutdown: ${reason} (session=${currentSessionId || 'none'})`);
     process.exit(0);
   }
   ```

3. **新增 `bridgeInitiatedKill` 状态变量**:
   - 顶部声明 `let bridgeInitiatedKill = false;`
   - `gracefulShutdown()` 中 kill ACP 前设为 `true`
   - `stopBridge()` 中 kill ACP 前设为 `true`
   - 用于 exit handler 判断 `terminatedBy` 来源

4. **`acp.on('exit')` handler 添加 `terminatedBy` 字段**:
   - 根据 `bridgeInitiatedKill` 和 `signal` 判断终止来源：
     - `bridgeInitiatedKill === true` → `"bridge"`
     - `signal !== null && bridgeInitiatedKill === false` → `"external"`
     - `signal === null` → `"self"`

   ```javascript
   acp.on('exit', (code, signal) => {
     acpReady = false;
     const terminatedBy = bridgeInitiatedKill ? 'bridge'
       : signal ? 'external'
       : 'self';
     for (const [, p] of pending.entries()) {
       p.reject(new Error(`ACP exited before response (method=${p.method}, code=${code}, signal=${signal})`));
     }
     pending.clear();
     saveState();
     emit({ type: 'exit', code, signal, terminatedBy });
     notifyUser(`ACP process exited (code=${code}, signal=${signal}, terminatedBy=${terminatedBy}, session=${currentSessionId || 'none'})`);
   });
   ```

5. **`stopBridge()` 设置 `bridgeInitiatedKill`**:
   - `op:stop` 是用户主动停止，不受 grace period 影响
   - kill 前设置 `bridgeInitiatedKill = true`

   ```javascript
   function stopBridge() {
     clearInterval(heartbeatTimer);
     emit({ type: 'stop_requested', session: currentSessionId, pid: acp?.pid || null });
     bridgeInitiatedKill = true;
     if (acp && !acp.killed) acp.kill('SIGTERM');
   }
   ```

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 存在（exploratory），再在修复后验证进程组隔离、grace period 正确性和现有行为保持。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认 ACP 子进程与 bridge 共享进程组，且 `gracefulShutdown()` 不等待 pending RPC。

**Test Plan**: 编写测试脚本验证当前 bridge 的 spawn 选项和 shutdown 行为。

**Test Cases**:
1. **进程组共享测试**: 启动 bridge → start ACP → 检查 ACP 的 pgid 是否等于 bridge 的 pgid（will fail on unfixed code — pgid 相同）
2. **进程组信号传播测试**: 启动 bridge → start ACP → `kill(-bridge_pgid, SIGTERM)` → 检查 ACP 是否被终止（will fail on unfixed code — ACP 被杀死）
3. **立即 kill 测试**: 启动 bridge → start ACP → send prompt（创建 pending RPC）→ 发送 SIGTERM → 检查 bridge 是否立即 kill ACP 不等待 pending（will fail on unfixed code — 立即 kill）
4. **exit 事件缺少 terminatedBy**: 启动 bridge → start ACP → 终止 ACP → 检查 exit 事件是否包含 terminatedBy 字段（will fail on unfixed code — 无此字段）

**Expected Counterexamples**:
- ACP pgid === bridge pgid，进程组信号直接传播
- `gracefulShutdown()` 中 `acp.kill('SIGTERM')` 在 pending.size > 0 时立即执行
- exit 事件只有 `code` 和 `signal`，无 `terminatedBy`

### Fix Checking

**Goal**: 验证修复后，ACP 子进程在独立进程组中运行，SIGTERM 时等待 pending RPC 完成。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  bridge := start_bridge()
  start_acp(bridge)

  IF input.signalTarget == 'process_group'
    // 验证进程组隔离
    ASSERT acp.pgid != bridge.pgid
    kill(-bridge.pgid, SIGTERM)
    ASSERT acp_still_running()

  IF input.pendingCount > 0
    // 验证 grace period
    create_pending_rpc(bridge)
    send_sigterm(bridge)
    ASSERT bridge_waits_for_pending()
    ASSERT acp_not_killed_immediately()
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，所有非信号相关行为与修复前完全一致。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可以自动生成大量合法 JSONL 命令组合验证命令处理不变
- 能覆盖 `op:stop` 立即终止、ping/pong 响应格式等边界情况
- 对所有非信号相关输入提供强保证

**Test Plan**: 先在未修复代码上记录各命令的响应行为作为基准，然后在修复后验证响应一致。

**Test Cases**:
1. **JSONL 命令响应保持**: 验证 start、session_new、send、ping 等命令的响应格式和内容不变
2. **op:stop 立即终止保持**: 验证 `{"op":"stop"}` 仍立即 kill ACP，不受 grace period 影响
3. **心跳输出保持**: 验证 heartbeat 事件格式和间隔不变
4. **FIFO 控制通道保持**: 验证 `--control fifo` 模式行为不变
5. **ACP 正常退出处理保持**: 验证无 in-flight RPC 时 ACP 退出的处理流程不变（除新增 `terminatedBy` 字段外）

### Unit Tests

- 测试 `spawn()` 选项包含 `detached: true`
- 测试 `gracefulShutdown()` 在 `pending.size > 0` 时等待，`pending.size === 0` 时立即 shutdown
- 测试 30 秒超时后强制终止 ACP
- 测试 `bridgeInitiatedKill` 状态在 `gracefulShutdown()` 和 `stopBridge()` 中正确设置
- 测试 `terminatedBy` 字段在三种场景下的正确值
- 测试 `bridge_signal_received` 事件格式（signal、pendingCalls、timestamp）
- 测试 `op:stop` 不受 grace period 影响，仍立即 kill

### Property-Based Tests

- 生成随机 pending RPC 数量（0-10）和完成延迟（0-35s），验证 grace period 行为正确：pending > 0 时等待，pending === 0 时立即 shutdown，超时后强制终止
- 生成随机 JSONL 命令序列，验证修复后命令处理响应与修复前一致（preservation）
- 生成随机信号到达时机（ACP 启动前/初始化中/prompt 执行中/idle），验证 bridge 始终正确处理
- 生成随机 ACP 退出场景（正常退出/信号终止/bridge kill），验证 `terminatedBy` 字段始终正确

### Integration Tests

- 完整进程组隔离测试：启动 bridge → start ACP → 验证 pgid 不同 → `kill(-bridge_pgid, SIGTERM)` → 验证 ACP 仍在运行
- Grace period 集成测试：启动 bridge → start ACP → send prompt → SIGTERM → 验证 bridge 等待 prompt 完成 → 验证最终 shutdown
- 超时集成测试：启动 bridge → start ACP → send 长时间 prompt → SIGTERM → 验证 30 秒后强制终止
- op:stop 不受影响测试：启动 bridge → start ACP → send prompt → `{"op":"stop"}` → 验证立即 kill ACP
- 信号可观测性测试：SIGTERM → 验证 `bridge_signal_received` 事件 → 验证 exit 事件包含 `terminatedBy`
