# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - 有活跃 session 时 SIGTERM 无吸收机制，bridge 立即 shutdown
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the SIGTERM absorption bug exists
  - **Scoped PBT Approach**: Scope the property to concrete failing cases:
    - `isBugCondition({ signal: 'SIGTERM', acpReady: true, currentSessionId: 'sess_xxx', pendingSize: 0, sigTermCount: 0 })` → 有活跃 session 时第一次 SIGTERM 导致立即 shutdown 而非吸收
  - Write a Node.js test script (`tests/test-sigterm-resilience-bug-condition.js`) that:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process
    - Filters out `control_channel`、`heartbeat`、`bridge_signal_received` events（与现有测试模式一致）
    - Test 1 (代码检查：gracefulShutdown 无吸收逻辑): 读取 bridge 源码 → 验证 `gracefulShutdown()` 中没有 `sigTermCount` 变量 → WILL FAIL on unfixed code（确认缺少吸收机制）
    - Test 2 (代码检查：无 deferred 字段): 读取 bridge 源码 → 验证 `bridge_signal_received` 事件中没有 `deferred` 字段 → WILL FAIL on unfixed code
    - Test 3 (代码检查：SKILL.md 无 setsid): 读取 SKILL.md → 验证启动命令不包含 `setsid` → WILL FAIL on unfixed code
    - Test 4 (行为测试：无 session 时 SIGTERM 立即退出): 启动 bridge（无 ACP，无 session）→ 发送 SIGTERM → 验证 bridge 退出且输出 `shutdown` 事件 → WILL PASS on unfixed code（基线行为确认）
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests 1-3 FAIL, Test 4 PASS (confirms bug exists and baseline works)
  - Document counterexamples found:
    - `gracefulShutdown()` 中无 `sigTermCount`、`firstSigTermTime`、`sigTermTimeoutTimer` 变量
    - `bridge_signal_received` 事件无 `deferred` 字段
    - SKILL.md 启动命令无 `setsid`
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.6_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - 无活跃 session 时 SIGTERM 立即 shutdown、命令处理行为不变
  - **IMPORTANT**: Follow observation-first methodology
  - Write a Node.js test script (`tests/test-sigterm-resilience-preservation.js`) that reuses现有测试模式（参考 `test-signal-preservation.js`）:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process with stdin pipe
    - Filters out `control_channel`、`heartbeat`、`bridge_signal_received` events
    - Test 1 (无 session 时 SIGTERM 立即 shutdown): 启动 bridge（无 ACP）→ 发送 SIGTERM → 验证 bridge 退出且输出 `{"type":"shutdown","reason":"SIGTERM",...}` 事件 → WILL PASS
    - Test 2 (SIGINT 立即 shutdown): 启动 bridge → 发送 SIGINT → 验证 bridge 退出且输出 `{"type":"shutdown","reason":"SIGINT",...}` 事件 → WILL PASS（SIGINT 不受吸收机制影响）
    - Test 3 (op:stop 立即终止): `{"op":"stop"}` → 返回 `{"type":"stop_requested",...}` → WILL PASS
    - Test 4 (ping/pong 响应格式): `{"op":"ping"}` → 返回 `{"type":"pong","pid":null,"ready":false,...}` → WILL PASS
    - Test 5 (unknown op 错误): `{"op":"unknown_op"}` → 返回 `{"type":"bridge_error","message":"Unknown op: unknown_op"}` → WILL PASS
    - Test 6 (invalid JSON 错误): `not json` → 返回 `{"type":"bridge_error","message":"Invalid JSON input"}` → WILL PASS
    - Test 7 (bridge_signal_received 事件保留现有字段): 启动 bridge → 发送 SIGTERM → 验证 `bridge_signal_received` 事件包含 `signal`、`pendingCalls`、`timestamp` 字段 → WILL PASS
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. Fix for SIGTERM 吸收机制（有活跃 session 时第一次 SIGTERM 被吸收）

  - [x] 3.1 Add sigTermCount, firstSigTermTime, sigTermTimeoutTimer state variables
    - 在 `scripts/kiro-acp-bridge.js` 顶部（`let bridgeInitiatedKill` 附近）声明：
      - `let sigTermCount = 0;` — 记录收到的 SIGTERM 次数
      - `let firstSigTermTime = null;` — 记录第一次被吸收的 SIGTERM 时间戳
      - `let sigTermTimeoutTimer = null;` — 60 秒超时 timer 引用
    - _Bug_Condition: isBugCondition({ sigTermCount: 0 }) — 缺少吸收状态追踪_
    - _Expected_Behavior: 提供状态变量支持吸收逻辑判断_
    - _Preservation: 新增变量，不影响现有逻辑_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.2 Modify gracefulShutdown() to add SIGTERM absorption logic
    - 在现有 `if (shuttingDown) return;` 之后、`shuttingDown = true;` 之前，新增吸收判断：
    - 条件：`reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0`
    - 满足条件时：
      - 递增 `sigTermCount`
      - 记录 `firstSigTermTime = Date.now()`
      - 输出 `bridge_signal_received` 事件含 `deferred: true`
      - 启动 60 秒超时 timer（超时后调用 `gracefulShutdown('SIGTERM_TIMEOUT')`）
      - **return 不执行 shutdown**
    - 不满足条件时（第二次 SIGTERM、SIGINT、无活跃 session、有 pending RPC）：
      - 清除 `sigTermTimeoutTimer`（如果存在）
      - 继续执行现有 shutdown 逻辑
    - _Bug_Condition: isBugCondition({ signal: 'SIGTERM', acpReady: true, currentSessionId: 'sess_xxx', pendingSize: 0, sigTermCount: 0 })_
    - _Expected_Behavior: 第一次 SIGTERM 被吸收，bridge 继续运行；第二次 SIGTERM 或 60 秒超时后执行 shutdown_
    - _Preservation: SIGINT 始终立即 shutdown；无活跃 session 时 SIGTERM 立即 shutdown；有 pending RPC 时走 grace period_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.3 Update bridge_signal_received event to include deferred field
    - 吸收时输出：`{"type":"bridge_signal_received","signal":"SIGTERM","pendingCalls":0,"timestamp":"<ISO>","deferred":true}`
    - 非吸收时（现有 shutdown 路径）：现有 `bridge_signal_received` 事件新增 `deferred: false` 字段
    - 保留现有字段（`signal`、`pendingCalls`、`timestamp`）不变
    - _Bug_Condition: 现有事件缺少 deferred 字段，无法区分吸收和非吸收_
    - _Expected_Behavior: deferred: true 表示吸收，deferred: false 表示正常 shutdown_
    - _Preservation: 现有字段不变，仅新增 deferred 字段_
    - _Requirements: 2.1, 3.8_

  - [x] 3.4 Update SKILL.md launch commands to add setsid
    - 将所有 `bash background:true command:"node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js"` 改为：
      `bash background:true command:"setsid node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js"`
    - 同样更新 `--control fifo` 和 `--control-path` 变体的启动命令
    - `setsid` 使 bridge 进程获得新的 session 和进程组，脱离宿主进程组
    - _Bug_Condition: bridge 在宿主进程组中，宿主 SIGTERM 传播到 bridge_
    - _Expected_Behavior: bridge 脱离宿主进程组，减少宿主误杀概率_
    - _Preservation: bridge 功能不变，仅启动方式改变_
    - _Requirements: 2.6_

  - [x] 3.5 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - SIGTERM 吸收机制
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms:
      - `gracefulShutdown()` 包含 `sigTermCount` 吸收逻辑
      - `bridge_signal_received` 事件包含 `deferred` 字段
      - SKILL.md 启动命令包含 `setsid`
    - Run `tests/test-sigterm-resilience-bug-condition.js`
    - **EXPECTED OUTCOME**: All tests PASS (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6_

  - [x] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - 无活跃 session 时 SIGTERM 立即 shutdown、命令处理行为不变
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run `tests/test-sigterm-resilience-preservation.js`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm 无 session 时 SIGTERM 立即 shutdown、SIGINT 立即 shutdown、op:stop 立即终止、ping/pong 格式不变、bridge_signal_received 现有字段保留

  - [x] 3.7 Verify existing test-signal-bug-condition.js still passes
    - Run `tests/test-signal-bug-condition.js`（前一个 bugfix 的 bug condition 测试，4 个测试）
    - **EXPECTED OUTCOME**: All 4 tests PASS
    - 注意：Test 4 (full event format) 验证 `bridge_signal_received` 事件格式，修复后新增 `deferred` 字段不应破坏现有字段检查
    - 如果测试因新增 `deferred` 字段而失败，需适配测试以接受新字段（但不删除现有字段检查）
    - _Requirements: 3.8_

  - [x] 3.8 Verify existing test-signal-preservation.js still passes
    - Run `tests/test-signal-preservation.js`（前一个 bugfix 的 preservation 测试，7 个测试）
    - **EXPECTED OUTCOME**: All 7 tests PASS
    - 特别关注 Test 7 (SIGTERM shutdown event)：无活跃 session 时 SIGTERM 仍应立即 shutdown，不受吸收机制影响
    - _Requirements: 3.1, 3.2, 3.3, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all SIGTERM resilience tests: `test-sigterm-resilience-bug-condition.js` and `test-sigterm-resilience-preservation.js`
  - Run all existing test suites to verify no regressions:
    - `tests/test-signal-bug-condition.js` (4 tests)
    - `tests/test-signal-preservation.js` (7 tests)
    - `tests/test-bug-condition-exploration.js` (4 tests)
    - `tests/test-preservation-properties.js` (6 tests)
    - `tests/test-fifo-bug-condition.js` (3 tests)
    - `tests/test-fifo-preservation.js` (7 tests)
  - Ensure all tests pass, ask the user if questions arise
