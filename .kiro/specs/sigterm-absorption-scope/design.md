# SIGTERM 吸收条件范围 Bugfix Design

## Overview

ACP bridge (`scripts/kiro-acp-bridge.js`) 的 SIGTERM 吸收条件过严，包含了 `currentSessionId` 和 `pending.size === 0` 两个不必要的子条件，导致 SIGTERM 在 `session_new` RPC 进行中时无法被吸收。修复方向：将吸收条件从 5 个子条件缩减为 3 个——`reason === 'SIGTERM' && acpReady && sigTermCount === 0`。这是一行条件修改。

## Glossary

- **Bug_Condition (C)**: 吸收条件包含 `currentSessionId` 和 `pending.size === 0`，导致 SIGTERM 在 session 建立过程中不被吸收
- **Property (P)**: 吸收条件仅依赖 `acpReady` 和 `sigTermCount === 0`，不受 session 状态或 pending RPC 数量影响
- **Preservation**: `!acpReady` 时 SIGTERM 立即 shutdown、SIGINT 立即 shutdown、`op:stop` 立即终止、所有命令处理不变、FIFO 恢复不变、第二次 SIGTERM 和 60 秒超时行为不变
- **gracefulShutdown()**: `scripts/kiro-acp-bridge.js` 中处理 SIGTERM/SIGINT 的函数，吸收条件判断是本次修改的唯一位置
- **sigTermCount**: 已有计数器，记录收到的 SIGTERM 次数，用于区分第一次和后续 SIGTERM
- **acpReady**: 已有 flag，标记 ACP 子进程是否已完成 `initialize` RPC

## Bug Details

### Bug Condition

Bug 在以下场景触发：bridge 收到 SIGTERM 时，`session_new` RPC 正在进行中。此时 `pending.size > 0`（RPC 在 Map 中）或 `currentSessionId === null`（尚未被赋值），吸收条件中的 `currentSessionId` 和 `pending.size === 0` 子条件不满足，bridge 跳过吸收逻辑，进入 grace period → shutdown。这与 SIGTERM 到达的精确时刻有关，导致第 4 次（成功吸收）和第 5 次（直接 shutdown）实测结果交替出现。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { absorptionCondition: string }
  OUTPUT: boolean

  RETURN input.absorptionCondition contains 'currentSessionId'
         OR input.absorptionCondition contains 'pending.size === 0'
END FUNCTION
```

真正的不变量是：**ACP 进程已初始化（`acpReady`）时，第一次 SIGTERM 就应该被吸收**，不论 session 状态或 pending RPC 数量。当前条件过严，将 session 状态和 pending RPC 数量纳入吸收判断，引入了竞态窗口。

### Examples

- **路径 A（成功吸收）**: SIGTERM 在 `session_new` RPC 完成之后到达 → `currentSessionId` 有值且 `pending.size === 0` → 吸收条件满足 → `deferred: true`（期望：吸收。实际：吸收。但依赖时序）
- **路径 B（直接 shutdown）**: SIGTERM 在 `session_new` RPC 还在 pending 时到达 → `pending.size > 0` → 吸收条件不满足 → grace period → shutdown（期望：吸收。实际：shutdown）
- **路径 C（直接 shutdown）**: SIGTERM 在 `createSession()` 中 `await rpc(...)` 还没 resolve 时到达 → `currentSessionId === null` → 吸收条件不满足 → shutdown（期望：吸收。实际：shutdown）
- **修复后**: SIGTERM 在任何时刻到达，只要 `acpReady && sigTermCount === 0` → 吸收（期望：吸收。实际：吸收。不依赖时序）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `acpReady === false` 时 SIGTERM 立即执行 graceful shutdown（ACP 未初始化，无需保护）
- SIGINT 始终立即执行 graceful shutdown（用户明确终止意图）
- `{"op":"stop"}` 立即终止 ACP 子进程并关闭 bridge
- 第二次 SIGTERM（`sigTermCount > 0`）立即执行 graceful shutdown
- 60 秒超时后自动执行 graceful shutdown
- SIGTERM 吸收后建立 FIFO 备用控制通道（session-recovery 行为不变）
- 所有 JSONL 命令处理和响应格式不变
- 心跳事件、keepalive 机制不变
- `bridge_signal_received` 事件格式不变（含 `signal`、`pendingCalls`、`timestamp`、`deferred` 字段）

**Scope:**
修改仅涉及 `gracefulShutdown()` 中吸收条件的 `if` 语句。移除 `currentSessionId &&` 和 `pending.size === 0 &&` 两个子条件。吸收路径内部的所有逻辑（`sigTermCount++`、`firstSigTermTime`、60 秒超时、FIFO 建立、`deferred: true` 事件）完全不变。

## Hypothesized Root Cause

基于 bug report 和代码分析，根因明确：

1. **吸收条件过严**: `gracefulShutdown()` 第 318 行的吸收条件为：
   ```javascript
   if (reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0)
   ```
   其中 `currentSessionId` 和 `pending.size === 0` 两个子条件引入了竞态窗口。当 SIGTERM 在 `session_new` RPC 进行中到达时，这两个条件中至少一个不满足，导致吸收失败。

2. **竞态窗口分析**:
   - `createSession()` 调用 `await rpc('session/new', ...)` 时，RPC 被加入 `pending` Map（`pending.size > 0`）
   - RPC resolve 后，`currentSessionId = result?.sessionId` 被赋值
   - 只有在 RPC resolve 之后、下一个 RPC 发起之前的窗口内，`currentSessionId` 有值且 `pending.size === 0` 同时满足
   - SIGTERM 到达的时刻决定了是否命中这个窗口——这就是第 4 次和第 5 次实测交替出现的原因

3. **真正的不变量**: ACP 进程已初始化（`acpReady === true`）意味着 bridge 已经在正常工作，无论当前是否有活跃 session 或 pending RPC，第一次 SIGTERM 都应该被吸收。`currentSessionId` 和 `pending.size` 是 session 层面的状态，不应影响信号层面的吸收决策。

## Correctness Properties

Property 1: Bug Condition - 吸收条件不包含 session 状态和 pending RPC 条件

_For any_ `gracefulShutdown()` 中的 SIGTERM 吸收条件，修复后的条件 SHALL 不包含 `currentSessionId` 和 `pending.size === 0` 子条件。吸收条件仅为 `reason === 'SIGTERM' && acpReady && sigTermCount === 0`。

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - 非吸收路径行为不变

_For any_ 不满足吸收条件的输入（`!acpReady` 时 SIGTERM、SIGINT、`op:stop`、第二次 SIGTERM、60 秒超时），修复后的 bridge SHALL 产生与修复前完全相同的行为，保持所有现有功能、事件格式和 shutdown 逻辑不变。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9**

## Fix Implementation

### Changes Required

根因明确，修改为一行条件变更：

**File**: `scripts/kiro-acp-bridge.js`

**Function**: `gracefulShutdown()`

**Specific Changes**:

1. **修改吸收条件（第 318 行）**:
   - 当前条件：
     ```javascript
     if (reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0)
     ```
   - 修改为：
     ```javascript
     if (reason === 'SIGTERM' && acpReady && sigTermCount === 0)
     ```
   - 移除 `currentSessionId &&` 和 `pending.size === 0 &&` 两个子条件
   - 吸收路径内部的所有逻辑完全不变

2. **无其他文件需要修改**: 吸收路径内部的 `sigTermCount++`、`firstSigTermTime`、60 秒超时 timer、FIFO 建立、`deferred: true` 事件输出等逻辑全部保持不变。注释可以更新以反映新的条件语义。

**影响分析**:
- 修复前：吸收仅在 `acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0` 时触发
- 修复后：吸收在 `acpReady && sigTermCount === 0` 时触发
- 新增覆盖场景：`acpReady && !currentSessionId`（session 建立中）、`acpReady && pending.size > 0`（RPC 进行中）
- 不受影响场景：`!acpReady`（仍立即 shutdown）、`sigTermCount > 0`（仍立即 shutdown）、SIGINT（仍立即 shutdown）

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 存在（吸收条件包含 `currentSessionId` 和 `pending.size === 0`），再在修复后验证条件已放宽且所有现有 53+ 测试继续通过。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认吸收条件包含不必要的子条件。

**Test Plan**: 通过代码静态检查验证 `gracefulShutdown()` 中的吸收条件包含 `currentSessionId` 和 `pending.size === 0`。

**Test Cases**:
1. **代码检查：吸收条件包含 currentSessionId**: 读取 bridge 源码 → 验证吸收条件 `if` 语句中包含 `currentSessionId`（will fail on unfixed code — 确认条件过严）
2. **代码检查：吸收条件包含 pending.size**: 读取 bridge 源码 → 验证吸收条件 `if` 语句中包含 `pending.size === 0`（will fail on unfixed code — 确认条件过严）
3. **基线确认：无 session 时 SIGTERM 立即 shutdown**: 启动 bridge → 发送 SIGTERM → 验证 bridge 退出（will pass on both — 确认 `!acpReady` 路径不变）

**Expected Counterexamples**:
- 吸收条件 `if` 语句中包含 `currentSessionId` 子条件
- 吸收条件 `if` 语句中包含 `pending.size === 0` 子条件
- 这两个子条件导致 SIGTERM 在 `session_new` RPC 进行中时不被吸收

### Fix Checking

**Goal**: 验证修复后，吸收条件不再包含 `currentSessionId` 和 `pending.size === 0`。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  src := readFile('scripts/kiro-acp-bridge.js')
  absorptionLine := findAbsorptionCondition(src)
  ASSERT NOT absorptionLine.contains('currentSessionId')
  ASSERT NOT absorptionLine.contains('pending.size === 0')
  ASSERT absorptionLine.contains('acpReady')
  ASSERT absorptionLine.contains('sigTermCount === 0')
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，所有非吸收路径的行为不变。所有现有 53+ 测试必须继续通过。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: 复用现有 10 个测试套件（53+ 测试）验证所有现有行为不变。由于修改仅为一行条件缩减，不新增逻辑，preservation 风险极低。关键验证点：
- `!acpReady` 时 SIGTERM 仍立即 shutdown（条件中 `acpReady` 保留）
- `sigTermCount > 0` 时仍立即 shutdown（条件中 `sigTermCount === 0` 保留）
- SIGINT 仍立即 shutdown（条件中 `reason === 'SIGTERM'` 保留）

**Test Plan**: 运行所有现有测试套件确认无回归。

**Test Cases**:
1. **无 session 时 SIGTERM 立即 shutdown**: 现有 test-sigterm-resilience-preservation.js Test 1、test-session-recovery-preservation.js Test 1
2. **SIGINT 立即 shutdown**: 现有 test-sigterm-resilience-preservation.js Test 2、test-session-recovery-preservation.js Test 2
3. **op:stop 立即终止**: 现有 test-sigterm-resilience-preservation.js Test 3、test-session-recovery-preservation.js Test 3
4. **ping/pong 响应格式**: 现有 test-sigterm-resilience-preservation.js Test 4、test-session-recovery-preservation.js Test 4
5. **命令处理不变**: 现有 test-signal-preservation.js、test-preservation-properties.js
6. **FIFO 行为不变**: 现有 test-fifo-preservation.js、test-fifo-bug-condition.js
7. **SIGTERM 吸收机制不变**: 现有 test-sigterm-resilience-bug-condition.js（吸收逻辑内部不变）
8. **Session recovery 不变**: 现有 test-session-recovery-bug-condition.js、test-session-recovery-preservation.js
9. **bridge_signal_received 事件格式**: 现有 test-sigterm-resilience-preservation.js Test 7

### Unit Tests

- 代码检查：吸收条件不包含 `currentSessionId`
- 代码检查：吸收条件不包含 `pending.size === 0`
- 代码检查：吸收条件包含 `acpReady` 和 `sigTermCount === 0`
- 行为测试：`!acpReady` 时 SIGTERM 立即 shutdown（复用现有测试）

### Property-Based Tests

- 生成随机 bridge 状态组合（acpReady: true/false, currentSessionId: null/string, pending.size: 0-5, sigTermCount: 0-2），验证修复后吸收条件仅依赖 `acpReady && sigTermCount === 0`，不依赖 `currentSessionId` 和 `pending.size`
- 生成随机 JSONL 命令序列，验证修复后命令处理响应与修复前一致（preservation）

### Integration Tests

- 运行所有现有 10 个测试套件（53+ 测试）确认无回归
- 重点关注 test-sigterm-resilience-bug-condition.js 和 test-session-recovery-bug-condition.js 仍通过（吸收逻辑内部不变）
