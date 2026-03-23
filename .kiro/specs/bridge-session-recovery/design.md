# Bridge Session Recovery Bugfix Design

## Overview

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 SIGTERM 吸收机制（bugfix #5）正确工作后，暴露了一个新问题：bridge 吸收 SIGTERM 后继续运行，但 OpenClaw 的 process session 被标记为 `failed`，stdio pipe 不再可用。bridge 处于"存活但不可控"的僵死状态——heartbeat 继续输出，但用户无法通过任何途径发送新命令。

修复策略：在 `gracefulShutdown()` 的 SIGTERM 吸收路径（`deferred: true` 分支）中，吸收后立即调用 `setupFifoControl()` 建立 FIFO 备用控制通道，并输出 `control_channel` 事件通知 agent FIFO 路径。同时防止 stdin EOF 时重复创建 FIFO。

## Glossary

- **Bug_Condition (C)**: bridge 以 stdio 模式运行，吸收 SIGTERM（`deferred: true`）后，没有主动建立 FIFO 备用控制通道，导致 OpenClaw stdio session 失效后 bridge 不可控
- **Property (P)**: SIGTERM 吸收后 bridge 应立即建立 FIFO 备用控制通道，确保 stdio session 失效后仍可被控制
- **Preservation**: stdio 正常运行不创建 FIFO、stdin EOF fallback 不变、FIFO 模式不变、SIGTERM 吸收/超时/第二次 SIGTERM 行为不变、graceful shutdown 清理 FIFO 不变
- **gracefulShutdown()**: `scripts/kiro-acp-bridge.js` 中处理 SIGTERM/SIGINT 的函数，SIGTERM 吸收路径是本次修改的核心位置
- **setupFifoControl()**: `scripts/kiro-acp-bridge.js` 中已有的 FIFO 控制通道建立函数，创建 FIFO 文件并启动读取循环
- **fifoFallbackCreated**: 新增 flag，标记是否已通过 SIGTERM 吸收路径或 stdin EOF 创建了 FIFO fallback，防止重复创建
- **control_channel 事件**: bridge 输出的 JSON 事件，通知 agent 当前控制通道模式和路径

## Bug Details

### Bug Condition

Bug 在以下场景触发：bridge 以 stdio 模式启动，完成 `session_new` 建立活跃 session 后，宿主进程管理器发送 SIGTERM。bugfix #5 的吸收机制正确工作——bridge 输出 `deferred: true` 并继续运行。但 OpenClaw 将该 process session 标记为 `failed`，stdio pipe 不再被写入（但未必触发 EOF）。此时 bridge 没有主动建立 FIFO 备用通道，用户无法通过 `process action:submit` 发送新命令，bridge 处于僵死状态。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { controlMode: string, sigTermAbsorbed: boolean, fifoFallbackCreated: boolean }
  OUTPUT: boolean

  RETURN input.controlMode == 'stdio'
         AND input.sigTermAbsorbed == true
         AND input.fifoFallbackCreated == false
END FUNCTION
```

### Examples

- **典型场景**: bridge 以 stdio 模式启动 → `start` ACP → `session_new` 成功 → 宿主发 SIGTERM → bridge 吸收（`deferred: true`）→ OpenClaw session 标记 `failed` → 用户尝试 `process action:submit` → "No active session found" → bridge 仍在运行但不可控（期望：SIGTERM 吸收后立即建立 FIFO，用户可通过 FIFO 继续控制）
- **stdin EOF 后续**: bridge 吸收 SIGTERM 并建立 FIFO → 稍后 stdin 触发 EOF → `rl.on('close', ...)` 不应重复创建 FIFO（期望：`fifoFallbackCreated` flag 阻止重复创建）
- **FIFO 模式启动**: bridge 以 `--control fifo` 模式启动 → 收到 SIGTERM 并吸收 → 已有 FIFO 通道 → 不需要创建新 FIFO（期望：`controlMode === 'fifo'` 条件跳过 FIFO 创建）
- **control_channel 事件**: bridge 吸收 SIGTERM 并建立 FIFO → 输出 `{"type":"control_channel","mode":"fifo","path":"/tmp/kiro-acp-bridge-PID.fifo","reason":"sigterm_recovery"}`（期望：agent 可从事件中获取 FIFO 路径）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- bridge 以 stdio 模式正常运行（未收到 SIGTERM）时，通过 stdin 接收命令，不主动创建 FIFO
- bridge 的 stdin 收到 EOF 时，通过现有 `rl.on('close', ...)` 机制自动创建 FIFO fallback 通道（如果尚未创建）
- bridge 收到 SIGTERM 且没有活跃 session 时，立即执行 graceful shutdown，不建立 FIFO
- bridge 以 `--control fifo` 模式启动时，使用启动时指定的 FIFO 路径，SIGTERM 吸收路径不重复创建 FIFO
- bridge 吸收第一次 SIGTERM 后收到第二次 SIGTERM 时，执行 graceful shutdown（sigterm-resilience 现有行为不变）
- bridge 吸收第一次 SIGTERM 后超过 60 秒未收到第二次 SIGTERM 时，自动执行 graceful shutdown
- 所有 JSONL 命令（start、session_new、send、reply、cancel、ping 等）处理和响应格式不变
- 心跳事件、keepalive 机制不变
- graceful shutdown 时清理 FIFO 文件（包括 SIGTERM 吸收路径创建的 FIFO）

**Scope:**
所有不涉及 SIGTERM 吸收路径中 FIFO 创建逻辑的行为应完全不受此修复影响。修改仅在 `gracefulShutdown()` 的 `deferred: true` 分支中添加 FIFO 建立逻辑，以及在 stdin EOF handler 中添加重复创建防护。

## Hypothesized Root Cause

基于 bug report 和代码分析，根因如下：

1. **SIGTERM 吸收路径缺少 FIFO 建立**: `gracefulShutdown()` 的 `deferred: true` 分支在吸收 SIGTERM 后直接 `return`，没有调用 `setupFifoControl()` 建立备用控制通道。bridge 继续运行但仅依赖 stdio，而 OpenClaw 的 stdio session 已失效。

2. **两个现有机制之间的断层**: 代码中已有两个相关机制——(a) SIGTERM 吸收（`deferred: true`，让 bridge 继续运行）和 (b) stdin EOF → FIFO fallback（`rl.on('close', ...)`，在 stdin 关闭时创建 FIFO）。但 OpenClaw session `failed` 不一定触发 stdin EOF，导致机制 (b) 可能不触发。需要在机制 (a) 中主动建立 FIFO，而不是被动等待机制 (b)。

3. **无 FIFO 重复创建防护**: 如果 SIGTERM 吸收路径创建了 FIFO，稍后 stdin EOF 也触发了 `rl.on('close', ...)`，会尝试再次调用 `setupFifoControl()`，导致 `mkfifo` 失败（文件已存在）。需要一个 flag 防止重复创建。

4. **control_channel 事件缺少 reason 字段**: 现有的 `control_channel` 事件没有 `reason` 字段，agent 无法区分 FIFO 是启动时创建的、stdin EOF 创建的、还是 SIGTERM 恢复创建的。

## Correctness Properties

Property 1: Bug Condition - SIGTERM 吸收后建立 FIFO 备用控制通道

_For any_ bridge 以 stdio 模式运行且吸收了 SIGTERM（`deferred: true`）的状态，修复后的 `gracefulShutdown()` SHALL 在吸收 SIGTERM 后立即调用 `setupFifoControl()` 建立 FIFO 备用控制通道（路径 `/tmp/kiro-acp-bridge-${process.pid}.fifo`），并输出包含 `reason: "sigterm_recovery"` 的 `control_channel` 事件。

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation - 非 SIGTERM 吸收路径行为不变

_For any_ 不涉及 SIGTERM 吸收路径的输入（stdio 正常运行、stdin EOF fallback、FIFO 模式启动、无活跃 session 时 SIGTERM、第二次 SIGTERM、60 秒超时），修复后的 bridge SHALL 产生与修复前完全相同的行为，保持所有现有功能和事件格式不变。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

假设根因分析正确：

**File**: `scripts/kiro-acp-bridge.js`

**Function**: `gracefulShutdown()`

**Specific Changes**:

1. **新增状态变量**:
   - `let fifoFallbackCreated = false;` — 标记是否已通过 SIGTERM 吸收路径或 stdin EOF 创建了 FIFO fallback

2. **修改 SIGTERM 吸收路径（`deferred: true` 分支）**:
   - 在现有的 `return;` 之前，添加 FIFO 建立逻辑
   - 条件：`controlMode === 'stdio'`（已以 FIFO 模式启动的 bridge 不需要创建）
   - 调用 `setupFifoControl(fallbackPath)` 建立 FIFO
   - 设置 `fifoFallbackCreated = true`
   - 输出 `control_channel` 事件含 `reason: "sigterm_recovery"`

   ```javascript
   // 在 deferred: true 分支的 return 之前添加：
   if (controlMode === 'stdio') {
     const fallbackPath = `/tmp/kiro-acp-bridge-${process.pid}.fifo`;
     try {
       setupFifoControl(fallbackPath);
       fifoFallbackCreated = true;
       emit({ type: 'control_channel', mode: 'fifo', path: fallbackPath, reason: 'sigterm_recovery' });
     } catch (err) {
       emit({ type: 'bridge_error', message: `SIGTERM recovery FIFO failed: ${err.message}` });
     }
   }
   return; // 吸收，不执行 shutdown
   ```

3. **修改 stdin EOF handler（`rl.on('close', ...)`）**:
   - 在创建 FIFO 之前检查 `fifoFallbackCreated` flag
   - 如果已创建，跳过 FIFO 创建，仅输出 info 日志

   ```javascript
   rl.on('close', () => {
     emit({ type: 'info', message: 'stdin closed (EOF), bridge remains running via keepalive' });
     if (fifoFallbackCreated) {
       emit({ type: 'info', message: 'FIFO fallback already created (SIGTERM recovery), skipping' });
       return;
     }
     const fallbackPath = `/tmp/kiro-acp-bridge-${process.pid}.fifo`;
     try {
       setupFifoControl(fallbackPath);
       fifoFallbackCreated = true;
       emit({ type: 'control_channel', mode: 'fifo', path: fallbackPath });
       processCommand(JSON.stringify({ op: 'ping' }));
     } catch (err) {
       emit({ type: 'bridge_error', message: `FIFO fallback failed: ${err.message}` });
     }
   });
   ```

4. **扩展 graceful shutdown 的 FIFO 清理逻辑**:
   - 现有清理仅处理 `controlMode === 'fifo' && controlPath`
   - 需要额外清理 SIGTERM 吸收路径创建的 FIFO（`/tmp/kiro-acp-bridge-${process.pid}.fifo`）

   ```javascript
   // 在 gracefulShutdown 中现有 FIFO 清理之后添加：
   if (fifoFallbackCreated) {
     const fallbackPath = `/tmp/kiro-acp-bridge-${process.pid}.fifo`;
     try { fs.unlinkSync(fallbackPath); } catch {}
   }
   ```

5. **文档更新**:
   - `SKILL.md`: 无需修改（已有 `setsid`，bugfix #5 已添加）
   - `references/acp-bridge-protocol.md`: 文档化 `control_channel` 事件的 `reason: "sigterm_recovery"` 字段，说明 SIGTERM 吸收后的 FIFO 恢复路径

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 存在（SIGTERM 吸收路径缺少 FIFO 建立逻辑），再在修复后验证 FIFO 恢复机制正确性和现有行为保持。所有现有 42+ 测试必须继续通过。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认 SIGTERM 吸收路径缺少 FIFO 建立逻辑。

**Test Plan**: 通过代码静态检查验证 `gracefulShutdown()` 的 `deferred: true` 分支中没有 `setupFifoControl` 调用，以及行为测试验证 SIGTERM 吸收后没有 FIFO 被创建。

**Test Cases**:
1. **代码检查：SIGTERM 吸收路径缺少 setupFifoControl**: 读取 bridge 源码 → 检查 `deferred: true` 分支附近是否有 `setupFifoControl` 调用（will fail on unfixed code — 确认缺少 FIFO 建立）
2. **代码检查：缺少 fifoFallbackCreated flag**: 读取 bridge 源码 → 验证没有 `fifoFallbackCreated` 变量（will fail on unfixed code — 确认缺少重复创建防护）
3. **代码检查：control_channel 事件缺少 reason 字段**: 读取 bridge 源码 → 验证 `control_channel` 事件没有 `reason` 字段（will fail on unfixed code — 确认缺少 reason）
4. **基线确认：无 session 时 SIGTERM 立即 shutdown**: 启动 bridge → 发送 SIGTERM → 验证 bridge 退出（will pass on both — 确认基线行为）

**Expected Counterexamples**:
- `gracefulShutdown()` 的 `deferred: true` 分支在 `return` 前没有 FIFO 相关逻辑
- 没有 `fifoFallbackCreated` 变量
- `control_channel` 事件没有 `reason` 字段

### Fix Checking

**Goal**: 验证修复后，SIGTERM 吸收路径中有 `setupFifoControl` 调用，且 FIFO 被正确创建。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  bridge := start_bridge(controlMode='stdio')
  // 模拟 SIGTERM 吸收
  ASSERT bridge_source_contains('setupFifoControl') in deferred branch
  ASSERT bridge_source_contains('fifoFallbackCreated')
  ASSERT bridge_source_contains('reason') in control_channel event near deferred branch
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，所有非 SIGTERM 吸收路径的行为不变。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可以自动生成大量 JSONL 命令组合验证命令处理不变
- 能覆盖 stdin EOF fallback、FIFO 模式启动、无活跃 session SIGTERM 等边界情况
- 对所有非 SIGTERM-吸收-stdio 输入提供强保证

**Test Plan**: 复用现有 8 个测试套件（42+ 测试）验证所有现有行为不变，新增针对 FIFO 恢复机制的测试。

**Test Cases**:
1. **stdio 正常运行不创建 FIFO**: 验证 bridge 以 stdio 模式正常运行时不主动创建 FIFO（现有 test-fifo-preservation.js）
2. **stdin EOF fallback 不变**: 验证 stdin EOF 时仍通过 `rl.on('close', ...)` 创建 FIFO（现有行为，需验证 `fifoFallbackCreated` flag 不影响首次创建）
3. **FIFO 模式启动不变**: 验证 `--control fifo` 模式启动时行为不变（现有 test-fifo-bug-condition.js）
4. **无活跃 session SIGTERM 立即 shutdown**: 验证无活跃 session 时 SIGTERM 仍立即退出（现有 test-sigterm-resilience-preservation.js Test 1）
5. **ping/pong 响应格式不变**: 验证 ping 命令响应格式不变（现有多个测试套件）
6. **JSONL 命令处理不变**: 验证 unknown op、invalid JSON、send without ACP 等错误处理不变（现有多个测试套件）
7. **SIGTERM 吸收/超时/第二次 SIGTERM 行为不变**: 验证 sigterm-resilience 的核心行为不变（现有 test-sigterm-resilience-preservation.js、test-sigterm-resilience-bug-condition.js）
8. **graceful shutdown FIFO 清理**: 验证 shutdown 时清理 SIGTERM 吸收路径创建的 FIFO

### Unit Tests

- 测试 `gracefulShutdown()` 的 `deferred: true` 分支中有 `setupFifoControl` 调用（代码检查）
- 测试 `fifoFallbackCreated` flag 存在且在 SIGTERM 吸收路径中被设置
- 测试 `control_channel` 事件在 SIGTERM 恢复时包含 `reason: "sigterm_recovery"`
- 测试 stdin EOF handler 在 `fifoFallbackCreated === true` 时跳过 FIFO 创建
- 测试 `controlMode === 'fifo'` 时 SIGTERM 吸收路径不创建 FIFO
- 测试 graceful shutdown 清理 SIGTERM 吸收路径创建的 FIFO

### Property-Based Tests

- 生成随机 bridge 状态组合（controlMode: stdio/fifo, sigTermAbsorbed: true/false, fifoFallbackCreated: true/false），验证 FIFO 创建条件判断正确：仅在 `controlMode === 'stdio' && sigTermAbsorbed && !fifoFallbackCreated` 时创建
- 生成随机 JSONL 命令序列，验证修复后命令处理响应与修复前一致（preservation）
- 生成随机 SIGTERM/stdin-EOF 事件序列，验证 FIFO 不被重复创建

### Integration Tests

- 完整 SIGTERM 恢复流程测试：启动 bridge（stdio）→ ping 确认运行 → SIGTERM → 验证 `deferred: true` 事件 → 验证 `control_channel` 事件含 `reason: "sigterm_recovery"` → 验证 FIFO 文件存在
- FIFO 重复创建防护测试：SIGTERM 吸收创建 FIFO → stdin EOF → 验证不重复创建 FIFO
- FIFO 清理测试：SIGTERM 吸收创建 FIFO → 第二次 SIGTERM → graceful shutdown → 验证 FIFO 文件被删除
- 现有测试套件全部通过：test-signal-preservation.js、test-signal-bug-condition.js、test-fifo-preservation.js、test-fifo-bug-condition.js、test-preservation-properties.js、test-bug-condition-exploration.js、test-sigterm-resilience-preservation.js、test-sigterm-resilience-bug-condition.js
