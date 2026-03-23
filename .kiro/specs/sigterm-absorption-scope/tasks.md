# 实现计划

- [x] 1. 编写 bug condition 探索测试
  - **Property 1: Bug Condition** - SIGTERM 吸收条件包含不必要的 session 状态和 pending RPC 子条件
  - **重要**: 此测试必须在修复之前编写并运行
  - **目标**: 通过代码静态检查和行为测试，确认吸收条件过严的 bug 存在
  - **测试文件**: `tests/test-absorption-scope-bug-condition.js`
  - **Scoped PBT 方法**: 针对确定性 bug，将属性限定到具体失败场景——吸收条件中包含 `currentSessionId` 和 `pending.size === 0`
  - Test 1: 代码检查——吸收条件 `if` 语句中不包含 `currentSessionId`（从 design Bug Condition 中的 `isBugCondition` 伪代码）。断言修复后条件不含 `currentSessionId`。在未修复代码上运行 → FAIL（确认 bug 存在）
  - Test 2: 代码检查——吸收条件 `if` 语句中不包含 `pending.size === 0`（从 design Bug Condition 中的 `isBugCondition` 伪代码）。断言修复后条件不含 `pending.size === 0`。在未修复代码上运行 → FAIL（确认 bug 存在）
  - Test 3: 行为基线——无 session 时 SIGTERM 立即 shutdown（在未修复和修复后代码上均 PASS）
  - 在未修复代码上运行测试
  - **预期结果**: Test 1-2 FAIL（确认 bug 存在），Test 3 PASS（基线确认）
  - 记录发现的反例：吸收条件包含 `currentSessionId` 和 `pending.size === 0` 子条件
  - 测试编写完成、运行完成、失败已记录后标记任务完成
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. 编写 preservation 属性测试（在修复之前）
  - **Property 2: Preservation** - 非吸收路径行为不变
  - **重要**: 遵循观察优先方法论
  - **测试文件**: `tests/test-absorption-scope-preservation.js`
  - **测试助手必须过滤 `control_channel`、`heartbeat` 和 `bridge_signal_received` 事件**
  - 观察: 无 session 时 SIGTERM → bridge 立即 shutdown（`acpReady === false` 路径不变）
  - 观察: SIGINT → bridge 立即 shutdown（用户明确终止意图）
  - 观察: `{"op":"stop"}` → bridge 立即终止 ACP 子进程
  - 观察: `{"op":"ping"}` → 返回 pong 响应，格式正确
  - 观察: 未知 op → 返回 bridge_error
  - 观察: 无效 JSON → 返回 bridge_error
  - 观察: `bridge_signal_received` 事件包含 `signal`、`pendingCalls`、`timestamp`、`deferred` 字段
  - 编写属性测试：对所有不满足 bug condition 的输入（`!acpReady` 时 SIGTERM、SIGINT、`op:stop`、命令处理），修复前后行为一致（从 design Preservation Requirements）
  - 在未修复代码上运行测试
  - **预期结果**: 所有测试 PASS（确认基线行为）
  - 测试编写完成、运行完成、在未修复代码上全部通过后标记任务完成
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 3. 修复 SIGTERM 吸收条件范围

  - [x] 3.1 实现修复
    - 修改 `scripts/kiro-acp-bridge.js` 中 `gracefulShutdown()` 的吸收条件（约第 318 行）
    - 将 `if (reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0)` 修改为 `if (reason === 'SIGTERM' && acpReady && sigTermCount === 0)`
    - 移除 `currentSessionId &&` 和 `pending.size === 0 &&` 两个子条件
    - 更新注释以反映新的条件语义：ACP 已初始化时第一次 SIGTERM 即吸收，不依赖 session 状态或 pending RPC
    - 吸收路径内部逻辑完全不变（`sigTermCount++`、`firstSigTermTime`、60 秒超时、FIFO 建立、`deferred: true` 事件）
    - _Bug_Condition: isBugCondition(input) where input.absorptionCondition contains 'currentSessionId' OR 'pending.size === 0'_
    - _Expected_Behavior: 吸收条件仅为 reason === 'SIGTERM' && acpReady && sigTermCount === 0_
    - _Preservation: !acpReady 时 SIGTERM 立即 shutdown、SIGINT 立即 shutdown、op:stop 立即终止、第二次 SIGTERM 立即 shutdown、60 秒超时、FIFO 建立、命令处理、心跳、bridge_signal_received 格式_
    - _Requirements: 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.2 验证 bug condition 探索测试现在通过
    - **Property 1: Expected Behavior** - 吸收条件不包含 session 状态和 pending RPC 条件
    - **重要**: 重新运行任务 1 中的同一测试——不要编写新测试
    - 运行 `tests/test-absorption-scope-bug-condition.js`
    - **预期结果**: 所有测试 PASS（确认 bug 已修复）
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 验证 preservation 测试仍然通过
    - **Property 2: Preservation** - 非吸收路径行为不变
    - **重要**: 重新运行任务 2 中的同一测试——不要编写新测试
    - 运行 `tests/test-absorption-scope-preservation.js`
    - **预期结果**: 所有测试 PASS（确认无回归）

  - [x] 3.4 验证现有 test-sigterm-resilience-bug-condition.js 通过
    - 运行 `node tests/test-sigterm-resilience-bug-condition.js`
    - **预期结果**: 所有测试 PASS（吸收逻辑内部不变，sigTermCount/firstSigTermTime/deferred/setsid 均保留）

  - [x] 3.5 验证现有 test-sigterm-resilience-preservation.js 通过
    - 运行 `node tests/test-sigterm-resilience-preservation.js`
    - **预期结果**: 所有 7 个测试 PASS（无 session SIGTERM、SIGINT、op:stop、ping/pong、unknown op、invalid JSON、bridge_signal_received 字段）

  - [x] 3.6 验证现有 test-session-recovery-bug-condition.js 通过
    - 运行 `node tests/test-session-recovery-bug-condition.js`
    - **预期结果**: 所有测试 PASS（FIFO 恢复、fifoFallbackCreated、sigterm_recovery reason 均保留）

  - [x] 3.7 验证现有 test-session-recovery-preservation.js 通过
    - 运行 `node tests/test-session-recovery-preservation.js`
    - **预期结果**: 所有 7 个测试 PASS（无 session SIGTERM、SIGINT、op:stop、ping/pong、unknown op、invalid JSON、bridge_signal_received 字段）

- [x] 4. 检查点 — 确保所有测试通过
  - 运行所有 12 个测试套件（60+ 测试），确认无回归
  - 测试套件清单:
    - `tests/test-absorption-scope-bug-condition.js`（新增）
    - `tests/test-absorption-scope-preservation.js`（新增）
    - `tests/test-sigterm-resilience-bug-condition.js`
    - `tests/test-sigterm-resilience-preservation.js`
    - `tests/test-session-recovery-bug-condition.js`
    - `tests/test-session-recovery-preservation.js`
    - `tests/test-signal-bug-condition.js`
    - `tests/test-signal-preservation.js`
    - `tests/test-fifo-bug-condition.js`
    - `tests/test-fifo-preservation.js`
    - `tests/test-bug-condition-exploration.js`
    - `tests/test-preservation-properties.js`
  - 如有问题，询问用户
