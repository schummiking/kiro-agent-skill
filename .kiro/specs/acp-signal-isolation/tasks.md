# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - ACP 信号隔离（进程组共享 / 无 grace period / 缺少可观测性）
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the signal isolation bugs exist
  - **Scoped PBT Approach**: Scope the property to concrete failing cases for each bug condition:
    - `isBugCondition({ scenario: 'no_detached' })` → ACP spawn 未设置 `detached: true`，ACP 与 bridge 共享进程组
    - `isBugCondition({ scenario: 'no_grace_period', pendingCount: 1 })` → SIGTERM 时立即 kill ACP，不等待 pending RPC
    - `isBugCondition({ scenario: 'no_terminatedBy' })` → exit 事件缺少 `terminatedBy` 字段
    - `isBugCondition({ scenario: 'no_bridge_signal_received' })` → 收到 SIGTERM 时不输出 `bridge_signal_received` 事件
  - Write a Node.js test script (`tests/test-signal-bug-condition.js`) that:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process
    - Test 1 (detached flag): 启动 bridge → `{"op":"start"}` → 发送 SIGTERM → 检查 stdout 中是否有 `bridge_signal_received` 事件（间接验证信号处理改进，unfixed code 无此事件）→ WILL FAIL
    - Test 2 (terminatedBy field): 启动 bridge → 发送 SIGTERM → 等待 exit 事件 → 检查 exit 事件是否包含 `terminatedBy` 字段 → WILL FAIL（unfixed code 无此字段）
    - Test 3 (grace period): 启动 bridge → 发送 SIGTERM → 检查 bridge 是否输出 `bridge_signal_received` 事件且包含 `pendingCalls` 字段 → WILL FAIL（unfixed code 无此事件）
    - Test 4 (bridge_signal_received event): 启动 bridge → 发送 SIGTERM → 检查 stdout 中是否有 `{"type":"bridge_signal_received","signal":"SIGTERM","pendingCalls":...,"timestamp":...}` → WILL FAIL
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found:
    - SIGTERM → 无 `bridge_signal_received` 事件（直接输出 `shutdown` 事件）
    - exit 事件只有 `code` 和 `signal`，无 `terminatedBy` 字段
    - `gracefulShutdown()` 立即 kill ACP，无 grace period 等待
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - 命令处理和 SIGTERM shutdown 行为保持不变
  - **IMPORTANT**: Follow observation-first methodology
  - Write a Node.js test script (`tests/test-signal-preservation.js`) that reuses existing测试模式（参考 `test-fifo-preservation.js` 和 `test-preservation-properties.js`）:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process with stdin pipe
    - Test 1 (ping/pong 响应格式): `{"op":"ping"}` → 返回 `{"type":"pong","pid":null,"ready":false,...}` 格式不变
    - Test 2 (stop 命令行为): `{"op":"stop"}` → 返回 `{"type":"stop_requested","session":...,"pid":null}` 不变
    - Test 3 (unknown op): `{"op":"unknown_op"}` → 返回 `{"type":"bridge_error","message":"Unknown op: unknown_op"}` 不变
    - Test 4 (invalid JSON): `not json` → 返回 `{"type":"bridge_error","message":"Invalid JSON input"}` 不变
    - Test 5 (send without ACP): `{"op":"send","text":"hello"}` → 返回 `{"type":"bridge_error","op":"send","message":"ACP is not ready"}` 不变
    - Test 6 (empty line): 空行 → 无响应（被忽略）不变
    - Test 7 (SIGTERM shutdown 事件): 发送 SIGTERM → 仍输出 `{"type":"shutdown","reason":"SIGTERM",...}` 事件
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 3. Fix for ACP 信号隔离（detached spawn / grace period / 可观测性）

  - [x] 3.1 Add `detached: true` to spawn() in startAcp()
    - 在 `startAcp()` 中 `spawn('kiro-cli', args, { ... })` 的 options 添加 `detached: true`
    - 不调用 `acp.unref()`——bridge 仍需跟踪 ACP 生命周期
    - `detached: true` 使 ACP 获得独立进程组（pgid = ACP pid），进程组级 SIGTERM 不再传播
    - _Bug_Condition: isBugCondition({ scenario: 'no_detached' }) — ACP 与 bridge 共享进程组_
    - _Expected_Behavior: ACP pgid ≠ bridge pgid，进程组信号不传播_
    - _Preservation: 不影响 ACP stdin/stdout 通信、RPC 调用、exit 事件处理_
    - _Requirements: 2.1_

  - [x] 3.2 Add `bridgeInitiatedKill` state variable
    - 顶部声明 `let bridgeInitiatedKill = false;`
    - 用于 exit handler 判断 `terminatedBy` 来源
    - _Bug_Condition: isBugCondition({ scenario: 'no_terminatedBy' }) — exit 事件缺少终止来源_
    - _Expected_Behavior: 提供状态追踪，支持 terminatedBy 字段计算_
    - _Preservation: 新增变量，不影响现有逻辑_
    - _Requirements: 2.5_

  - [x] 3.3 Modify gracefulShutdown() to add grace period for pending RPCs
    - 收到 SIGTERM/SIGINT 时，先输出 `bridge_signal_received` 事件（含 signal、pendingCalls、timestamp）
    - 检查 `pending.size`：若 > 0，等待 pending 全部完成或 30 秒超时
    - 等待期间每秒检查 `pending.size`，全部完成则提前结束等待
    - 超时后输出超时警告，继续 shutdown 流程
    - 若 `pending.size === 0`，立即执行 shutdown（无延迟）
    - kill ACP 前设置 `bridgeInitiatedKill = true`
    - _Bug_Condition: isBugCondition({ scenario: 'no_grace_period', pendingCount > 0 }) — 立即 kill 不等待_
    - _Bug_Condition: isBugCondition({ scenario: 'no_bridge_signal_received' }) — 无信号接收事件_
    - _Expected_Behavior: pending > 0 时等待完成或超时；输出 bridge_signal_received 事件_
    - _Preservation: pending === 0 时行为与修复前一致（立即 shutdown）；shutdown 事件格式不变_
    - _Requirements: 2.2, 2.3, 2.4, 2.6_

  - [x] 3.4 Add `bridge_signal_received` event emission
    - 在 `gracefulShutdown()` 开头（shuttingDown 检查之后）输出：
      `{"type":"bridge_signal_received","signal":"<reason>","pendingCalls":<pending.size>,"timestamp":"<ISO>"}`
    - 此事件在 shutdown 事件之前输出，提供信号接收时刻的可观测性
    - _Bug_Condition: isBugCondition({ scenario: 'no_bridge_signal_received' })_
    - _Expected_Behavior: 每次收到 SIGTERM/SIGINT 时输出结构化事件_
    - _Preservation: 新增事件，不影响现有 shutdown 事件_
    - _Requirements: 2.4_

  - [x] 3.5 Add `terminatedBy` field to exit event in acp.on('exit') handler
    - 修改 `acp.on('exit', ...)` handler，在 emit exit 事件时添加 `terminatedBy` 字段：
      - `bridgeInitiatedKill === true` → `"bridge"`
      - `signal !== null && bridgeInitiatedKill === false` → `"external"`
      - `signal === null` → `"self"`
    - 同时更新 `notifyUser()` 调用，包含 `terminatedBy` 信息
    - _Bug_Condition: isBugCondition({ scenario: 'no_terminatedBy' }) — exit 事件缺少终止来源_
    - _Expected_Behavior: exit 事件包含 terminatedBy 字段，区分三种来源_
    - _Preservation: exit 事件原有字段（code、signal）不变，仅新增 terminatedBy_
    - _Requirements: 2.5_

  - [x] 3.6 Update stopBridge() to set bridgeInitiatedKill
    - `op:stop` 是用户主动停止，kill 前设置 `bridgeInitiatedKill = true`
    - `op:stop` 不受 grace period 影响，仍立即 kill ACP
    - _Bug_Condition: N/A — 确保 stop 命令的 terminatedBy 正确标记为 "bridge"_
    - _Expected_Behavior: stop 命令触发的 exit 事件 terminatedBy === "bridge"_
    - _Preservation: stop 命令行为（SIGTERM to ACP、stop_requested 事件）保持不变_
    - _Requirements: 3.3_

  - [x] 3.7 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - ACP 信号隔离
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms:
      - `bridge_signal_received` 事件在 SIGTERM 时输出
      - exit 事件包含 `terminatedBy` 字段
      - grace period 逻辑存在（pendingCalls 字段正确）
    - Run `tests/test-signal-bug-condition.js`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 3.8 Verify preservation tests still pass
    - **Property 2: Preservation** - 命令处理和 SIGTERM shutdown 行为保持不变
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run `tests/test-signal-preservation.js`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm ping/pong、stop、unknown op、invalid JSON、send without ACP、empty line、SIGTERM shutdown 行为不变
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all signal isolation tests: `test-signal-bug-condition.js` and `test-signal-preservation.js`
  - Run all existing test suites to verify no regressions:
    - `tests/test-bug-condition-exploration.js`
    - `tests/test-preservation-properties.js`
    - `tests/test-fifo-bug-condition.js`
    - `tests/test-fifo-preservation.js`
  - Ensure all tests pass, ask the user if questions arise
