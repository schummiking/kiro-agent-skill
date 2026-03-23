# Bridge Process Stability Bugfix Design

## Overview

ACP bridge 进程 (`scripts/kiro-acp-bridge.js`) 存在三个生命周期管理缺陷：(1) stdin EOF 导致 readline close 后事件循环无活跃 handle，进程立即退出；(2) SIGTERM/SIGINT 信号直接杀死进程，无 graceful shutdown；(3) 缺少心跳机制，宿主无法判断 bridge 存活状态。修复策略是：添加 keepalive timer 维持事件循环、注册信号处理器实现优雅关闭、添加周期性心跳输出。

## Glossary

- **Bug_Condition (C)**: 触发 bug 的条件集合——stdin EOF/pipe 关闭、SIGTERM/SIGINT 信号到达、长时间无 stdin 输入
- **Property (P)**: 期望行为——进程保持运行、优雅关闭、输出心跳
- **Preservation**: 现有 JSONL 命令处理、ACP 子进程管理、事件转发、权限自动处理等行为必须保持不变
- **bridge**: `scripts/kiro-acp-bridge.js`，OpenClaw 与 Kiro ACP 之间的唯一传输层
- **ACP 子进程**: 由 bridge 通过 `spawn('kiro-cli', ['acp', ...])` 启动的 Kiro CLI ACP 进程
- **readline (rl)**: Node.js `readline.createInterface({ input: process.stdin })` 实例，用于逐行读取 stdin JSONL 命令
- **keepalive timer**: 用于维持 Node.js 事件循环活跃的 `setInterval` 定时器
- **state file**: `scripts/kiro-acp-state.json`，bridge 持久化状态文件

## Bug Details

### Bug Condition

Bug 在以下三种场景中触发：(1) bridge 以后台进程启动后 stdin pipe 被关闭或收到 EOF，readline close 事件触发后事件循环无活跃 handle，Node.js 进程自动退出；(2) bridge 收到 SIGTERM/SIGINT 信号时直接终止，不执行任何清理；(3) bridge 长时间运行但无输出，宿主无法判断其存活状态。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { event: string, signal?: string }
  OUTPUT: boolean

  // 场景 1: stdin EOF 导致进程退出
  IF input.event == 'stdin_eof'
    RETURN true   // readline close → 无活跃 handle → 进程退出

  // 场景 2: 信号导致非优雅退出
  IF input.event == 'signal' AND input.signal IN ['SIGTERM', 'SIGINT']
    RETURN true   // 直接终止，无 cleanup

  // 场景 3: 长时间无心跳输出
  IF input.event == 'idle_period' AND input.duration > HEARTBEAT_INTERVAL
    RETURN true   // 宿主无法判断存活

  RETURN false
END FUNCTION
```

### Examples

- **stdin EOF**: `exec(background:true)` 启动 bridge 后，宿主关闭 stdin pipe → readline `close` 事件触发 → 进程退出（期望：进程保持运行）
- **SIGTERM**: 宿主执行 `process action:kill` 或系统回收 → bridge 直接终止 → ACP 子进程成为孤儿（期望：先关闭 ACP 子进程、保存状态、发送 exit 事件）
- **SIGINT**: 用户 Ctrl+C 或宿主发送 SIGINT → bridge 直接终止（期望：执行与 SIGTERM 相同的 graceful shutdown）
- **无心跳**: bridge 运行 30 分钟无 stdin 输入 → 宿主 `process action:log` 看不到新输出 → 误判为 idle 并回收（期望：定期输出 heartbeat 事件）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- 通过 stdin 发送的所有 JSONL 命令（start、session_new、session_load、send、reply、cancel、stop、ping）必须继续正确解析和执行
- ACP 子进程正常退出时的 exit 事件发送、pending promise 清理、状态保存、用户通知必须保持不变
- `{"op":"stop"}` 命令必须继续向 ACP 子进程发送 SIGTERM 并正常关闭
- `{"op":"ping"}` 命令必须继续返回包含 pid、ready、session、sessions 的 pong 响应
- `session/request_permission` 的自动处理策略（allow_always > allow_once > cancelled）必须保持不变
- `session/update` 通知的文本提取和 session_update 事件转发必须保持不变

**Scope:**
所有不涉及 stdin EOF、进程信号、心跳机制的输入和行为应完全不受此修复影响。包括：
- 正常的 JSONL 命令输入和响应
- ACP JSON-RPC 通信
- 状态文件读写（除 graceful shutdown 新增的保存点外）
- 用户通知（openclaw system event）

## Hypothesized Root Cause

基于代码分析，三个问题的根因如下：

1. **stdin EOF → 进程退出**: `readline.createInterface({ input: process.stdin })` 在 stdin EOF 时触发 `close` 事件。当前代码未注册 `rl.on('close', ...)` 处理器，也没有任何其他活跃的 handle（如 timer、server）维持事件循环。Node.js 在事件循环无活跃 handle 时自动退出进程。这是根本原因——bridge 的生命周期完全依赖 stdin readline，而后台进程的 stdin 可能随时被关闭。

2. **SIGTERM/SIGINT 无 graceful shutdown**: 当前代码未注册 `process.on('SIGTERM', ...)` 或 `process.on('SIGINT', ...)` 处理器。Node.js 对这两个信号的默认行为是立即终止进程（exit code 128 + signal number）。因此 ACP 子进程不会被显式关闭，状态不会被保存，exit 事件不会被发送。

3. **缺少心跳机制**: 当前代码没有任何周期性输出机制。bridge 只在收到命令或 ACP 事件时才向 stdout 写入。宿主侧通过 `process action:log` 读取输出来判断进程状态，长时间无输出会被误判为 idle。

## Correctness Properties

Property 1: Bug Condition - stdin EOF 后进程保持运行

_For any_ bridge 进程在 stdin pipe 被关闭或收到 EOF 的情况下，修复后的 bridge SHALL 保持进程运行（事件循环活跃），不因 readline close 而退出，直到收到显式的 stop 命令或终止信号。

**Validates: Requirements 2.1**

Property 2: Bug Condition - 信号触发 graceful shutdown

_For any_ SIGTERM 或 SIGINT 信号到达 bridge 进程时，修复后的 bridge SHALL 执行完整的 graceful shutdown 序列：(1) 向 ACP 子进程发送 SIGTERM，(2) 等待 ACP 子进程退出（带超时），(3) 保存状态到 state file，(4) 发送 exit 事件到 stdout，(5) 通知用户，(6) 退出进程。

**Validates: Requirements 2.2, 2.3**

Property 3: Bug Condition - 心跳事件定期输出

_For any_ bridge 进程在运行状态下，修复后的 bridge SHALL 每隔固定间隔（建议 30 秒）输出 `{"type":"heartbeat","pid":...,"uptime":...,"session":...}` 事件到 stdout，使宿主能判断 bridge 存活状态。

**Validates: Requirements 2.4**

Property 4: Preservation - JSONL 命令处理行为不变

_For any_ 通过 stdin 发送的合法 JSONL 命令（start、session_new、session_load、send、reply、cancel、stop、ping），修复后的 bridge SHALL 产生与修复前完全相同的响应和副作用，保持所有现有命令处理逻辑不变。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

假设根因分析正确，所有修改集中在 `scripts/kiro-acp-bridge.js` 一个文件：

**File**: `scripts/kiro-acp-bridge.js`

**Specific Changes**:

1. **添加 keepalive timer（解决 stdin EOF 退出问题）**:
   - 在文件顶部（`loadState()` 调用之前）添加一个 `setInterval` keepalive timer
   - 间隔 30 秒，同时兼作心跳输出
   - 这确保即使 stdin readline close，事件循环仍有活跃 handle
   - 使用 `timer.unref()` 不阻止正常退出（当 `stopBridge()` 被调用时）——**不可以 unref**，因为 unref 后 timer 不会阻止进程退出，这正是我们要避免的。timer 必须保持 ref 状态

   ```javascript
   const HEARTBEAT_INTERVAL_MS = 30_000;
   const startTime = Date.now();
   const heartbeatTimer = setInterval(() => {
     emit({
       type: 'heartbeat',
       pid: process.pid,
       uptime: Math.floor((Date.now() - startTime) / 1000),
       session: currentSessionId,
       ready: acpReady,
     });
   }, HEARTBEAT_INTERVAL_MS);
   ```

2. **处理 readline close 事件（stdin EOF 不退出）**:
   - 在 `rl` 创建后注册 `rl.on('close', ...)` 处理器
   - close 事件中仅发出一个 info 事件，不退出进程
   - keepalive timer 确保事件循环保持活跃

   ```javascript
   rl.on('close', () => {
     emit({ type: 'info', message: 'stdin closed (EOF), bridge remains running via keepalive' });
   });
   ```

3. **添加 graceful shutdown 函数**:
   - 创建 `async function gracefulShutdown(reason)` 函数
   - 序列：清除 heartbeat timer → 关闭 ACP 子进程（带 5 秒超时）→ 保存状态 → 发送 exit 事件 → 通知用户 → `process.exit(0)`
   - 使用 shutdown flag 防止重复执行

   ```javascript
   let shuttingDown = false;

   async function gracefulShutdown(reason) {
     if (shuttingDown) return;
     shuttingDown = true;

     clearInterval(heartbeatTimer);

     emit({ type: 'shutdown', reason, session: currentSessionId, pid: acp?.pid || null });

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

4. **注册 SIGTERM/SIGINT 信号处理器**:
   - 在文件末尾（rl 创建之后）注册信号处理器
   - 两个信号都调用 `gracefulShutdown`

   ```javascript
   process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
   process.on('SIGINT', () => gracefulShutdown('SIGINT'));
   ```

5. **修改 stopBridge 函数以使用 graceful shutdown**:
   - 现有的 `stopBridge()` 只是简单地 `acp.kill('SIGTERM')`
   - 修改为：清除 heartbeat timer，然后执行现有逻辑
   - stop 命令是用户主动关闭，ACP exit handler 会处理后续清理，所以不需要完整的 graceful shutdown
   - 但需要清除 heartbeat timer 以允许进程在 ACP 退出后自然结束

   ```javascript
   function stopBridge() {
     clearInterval(heartbeatTimer);
     emit({ type: 'stop_requested', session: currentSessionId, pid: acp?.pid || null });
     if (acp && !acp.killed) acp.kill('SIGTERM');
   }
   ```

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上复现 bug（exploratory），再在修复后验证 fix 正确性和行为保持。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上复现三个 bug，确认根因分析正确。

**Test Plan**: 编写 shell 脚本模拟三种 bug 触发场景，在未修复代码上运行观察失败行为。

**Test Cases**:
1. **stdin EOF 退出测试**: 启动 bridge，立即关闭 stdin（`echo '' | node kiro-acp-bridge.js`），检查进程是否立即退出（will fail on unfixed code — 进程会退出）
2. **SIGTERM 无 cleanup 测试**: 启动 bridge + mock ACP 子进程，发送 SIGTERM，检查 ACP 子进程是否仍在运行（will fail on unfixed code — ACP 成为孤儿）
3. **SIGINT 无 cleanup 测试**: 同上但发送 SIGINT（will fail on unfixed code）
4. **无心跳输出测试**: 启动 bridge，等待 60 秒，检查 stdout 是否有 heartbeat 输出（will fail on unfixed code — 无任何输出）

**Expected Counterexamples**:
- stdin EOF 后进程立即退出（exit code 0）
- SIGTERM 后 ACP 子进程仍在运行（`ps` 可查到）
- 60 秒内 stdout 无任何 heartbeat 输出

### Fix Checking

**Goal**: 验证修复后，所有 bug condition 输入都产生期望行为。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := bridge_fixed(input)
  IF input.event == 'stdin_eof'
    ASSERT process_still_running(result)
  IF input.event == 'signal'
    ASSERT graceful_shutdown_completed(result)
    ASSERT acp_child_terminated(result)
    ASSERT state_file_saved(result)
  IF input.event == 'idle_period'
    ASSERT heartbeat_events_emitted(result, expected_count)
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，所有非 bug condition 输入的行为与修复前完全一致。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可以自动生成大量合法 JSONL 命令组合
- 能覆盖手动测试遗漏的边界情况
- 对所有非 bug 输入提供强保证

**Test Plan**: 先在未修复代码上观察各命令的响应行为，记录为基准，然后在修复后验证响应一致。

**Test Cases**:
1. **JSONL 命令响应保持**: 验证 start、session_new、send、ping 等命令的响应格式和内容不变
2. **ACP 退出处理保持**: 验证 ACP 子进程正常退出时的 exit 事件、状态保存、通知行为不变
3. **stop 命令保持**: 验证 stop 命令仍然正确关闭 ACP 子进程
4. **ping/pong 保持**: 验证 ping 响应包含所有预期字段

### Unit Tests

- 测试 keepalive timer 创建和心跳事件输出格式
- 测试 gracefulShutdown 函数的完整序列（mock ACP 子进程）
- 测试 stdin EOF 后进程保持运行（检查 heartbeat timer 活跃）
- 测试 shutdown flag 防止重复执行
- 测试 stopBridge 清除 heartbeat timer

### Property-Based Tests

- 生成随机 JSONL 命令序列，验证修复后响应与修复前一致
- 生成随机时间点的 stdin EOF，验证进程始终保持运行
- 生成随机信号（SIGTERM/SIGINT）时机，验证 graceful shutdown 始终完成
- 测试心跳间隔在各种负载下保持稳定

### Integration Tests

- 完整流程测试：启动 bridge → start ACP → session_new → send prompt → stdin EOF → 验证 bridge 仍运行 → stop
- 信号处理集成测试：启动 bridge + ACP → SIGTERM → 验证 ACP 子进程已退出 + 状态已保存 + exit 事件已发送
- 心跳集成测试：启动 bridge → 等待 2 个心跳周期 → 验证 stdout 有 2+ 个 heartbeat 事件
- 多信号测试：快速连续发送 SIGTERM + SIGINT → 验证只执行一次 shutdown（shuttingDown flag）
