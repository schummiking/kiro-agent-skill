# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - FIFO 控制通道不支持 & stdin 关闭后不可控
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to three concrete failing cases:
    1. `--control fifo` 参数被忽略（bridge 不识别该参数，仍使用 stdin）
    2. stdin 关闭后 bridge 无法接收 ping 命令（僵尸状态）
    3. 启动时无 `control_channel` 事件输出
  - Test file: `tests/test-fifo-bug-condition.js`
  - 测试 1: 启动 `node kiro-acp-bridge.js --control fifo --control-path /tmp/test-fifo-$PID.fifo` → 验证 bridge 不创建 FIFO 文件（因为不支持该参数）→ FAIL
  - 测试 2: 启动 bridge → 关闭 stdin → 等待 1s → 尝试通过 stdin 发送 `{"op":"ping"}` → 验证无 pong 响应（stdin 已关闭，命令无法送达）→ FAIL
  - 测试 3: 启动 bridge → 检查 stdout 是否包含 `{"type":"control_channel",...}` 事件 → 验证无此事件（当前不输出）→ FAIL
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - stdio 模式行为不变
  - **IMPORTANT**: Follow observation-first methodology
  - Test file: `tests/test-fifo-preservation.js`
  - Observe behavior on UNFIXED code for non-buggy inputs (stdio mode):
    - Observe: `{"op":"ping"}` → `{"type":"pong","pid":null,"ready":false,"session":...,"initializeResult":null,"sessions":{}}` (无 controlMode/controlPath 字段)
    - Observe: `{"op":"stop"}` → `{"type":"stop_requested","session":...,"pid":null}`
    - Observe: `{"op":"unknown_op"}` → `{"type":"bridge_error","message":"Unknown op: unknown_op"}`
    - Observe: `not json` → `{"type":"bridge_error","message":"Invalid JSON input"}`
    - Observe: `{"op":"send","text":"hello"}` → `{"type":"bridge_error","op":"send","message":"ACP is not ready"}`
    - Observe: empty line → no response
  - Write property-based tests:
    - Property: 对于所有有效 JSONL 命令，默认模式（无 `--control` 参数）的响应格式和内容与修复前一致
    - Property: ping 响应不包含 controlMode 和 controlPath 字段（stdio 模式）
    - Property: graceful shutdown（SIGTERM）仍输出 shutdown 事件
    - Property: 心跳事件格式不变（type=heartbeat, 包含 pid/uptime/session/ready）
  - Verify tests pass on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Implement FIFO control channel fix

  - [x] 3.1 Add command-line argument parsing (`parseArgs`)
    - 在文件顶部（常量声明区域后）添加 `parseArgs(argv)` 函数
    - 解析 `--control <stdio|fifo>` 和 `--control-path <path>`
    - 默认值：controlMode='stdio'，controlPath=null（fifo 模式下自动生成 `/tmp/kiro-acp-bridge-<pid>.fifo`）
    - 在模块级别调用 `const { controlMode, controlPath } = parseArgs(process.argv)`
    - _Bug_Condition: isBugCondition(input) where controlMode == 'stdio' AND stdinState IN ['closed', 'eof']_
    - _Expected_Behavior: bridge 接受 --control fifo 参数并切换到 FIFO 控制通道_
    - _Preservation: 无参数或 --control stdio 时行为不变_
    - _Requirements: 2.1, 2.5, 2.7_

  - [x] 3.2 Extract `processCommand(line)` function (reuse command dispatch logic)
    - 将现有 `rl.on('line', async (line) => { ... })` 中的命令分发逻辑提取为独立的 `async function processCommand(line)`
    - 包含 JSON 解析、switch/case 分发、错误处理
    - stdin 模式的 `rl.on('line')` 改为调用 `processCommand(line)`
    - FIFO 模式也将调用同一个 `processCommand(line)`
    - _Bug_Condition: 命令处理逻辑与输入源耦合，无法复用_
    - _Expected_Behavior: 命令处理逻辑独立于输入源，stdin 和 FIFO 共享_
    - _Preservation: 命令分发行为完全不变（仅提取，不修改逻辑）_
    - _Requirements: 2.2, 3.1_

  - [x] 3.3 Implement FIFO control channel (`setupFifoControl`)
    - 使用 `execFileSync('mkfifo', [fifoPath])` 创建 named pipe
    - 实现 `openFifoReader()`: `fs.createReadStream(fifoPath)` → `readline.createInterface` → `rl.on('line', processCommand)`
    - EOF 处理: `rl.on('close')` → `stream.destroy()` → `emit info` → `setImmediate(() => openFifoReader())` 重新打开
    - stream error 处理: `stream.on('error')` → `emit bridge_error`
    - _Bug_Condition: bridge 无 FIFO 支持，stdin 关闭后成为僵尸_
    - _Expected_Behavior: FIFO 模式下控制通道在 bridge 整个生命周期内持续可用_
    - _Preservation: 此函数仅在 fifo 模式下调用，不影响 stdio 模式_
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 3.4 Emit `control_channel` event at startup
    - FIFO 模式: `emit({ type: 'control_channel', mode: 'fifo', path: controlPath })`
    - stdio 模式: `emit({ type: 'control_channel', mode: 'stdio' })`
    - 在控制通道初始化完成后立即输出
    - _Expected_Behavior: 调用方据此知道如何向 bridge 发送命令_
    - _Requirements: 2.3, 2.5_

  - [x] 3.5 Clean up FIFO file on graceful shutdown
    - 在 `gracefulShutdown()` 函数中，`clearInterval(heartbeatTimer)` 之后添加 FIFO 清理
    - `if (controlMode === 'fifo' && controlPath) { try { fs.unlinkSync(controlPath); } catch {} }`
    - 忽略 ENOENT 错误（文件可能已被删除）
    - _Expected_Behavior: shutdown 后不留下孤立的 FIFO 文件_
    - _Preservation: stdio 模式下此分支不执行_
    - _Requirements: 2.6, 3.3_

  - [x] 3.6 Extend ping/pong response for FIFO mode
    - FIFO 模式下 pong 响应额外包含 `controlMode` 和 `controlPath` 字段
    - stdio 模式下 pong 响应保持不变（不添加新字段）
    - _Expected_Behavior: FIFO 模式下 pong 包含控制通道信息_
    - _Preservation: stdio 模式下 pong 响应格式不变_
    - _Requirements: 3.6_

  - [x] 3.7 Wire up control channel initialization branch
    - 在文件末尾（原 `rl` 创建位置），根据 `controlMode` 选择初始化路径
    - `stdio`: 保持现有 `readline.createInterface({ input: process.stdin })` + `rl.on('line', processCommand)` + `rl.on('close', ...)`
    - `fifo`: 调用 `setupFifoControl(controlPath)`，stdin 不再用于命令输入
    - 两种模式都输出 `control_channel` 事件
    - _Bug_Condition: 控制通道硬编码为 stdin，无法切换_
    - _Expected_Behavior: 根据命令行参数选择 stdio 或 fifo 控制通道_
    - _Preservation: 默认行为（stdio）完全不变_
    - _Requirements: 2.1, 2.5_

  - [x] 3.8 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - FIFO 控制通道可靠工作
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied:
      - `--control fifo` 参数被识别，FIFO 文件被创建
      - FIFO 控制通道可接收命令
      - 启动时输出 `control_channel` 事件
    - Run: `node tests/test-fifo-bug-condition.js`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.9 Verify preservation tests still pass
    - **Property 2: Preservation** - stdio 模式行为不变
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run: `node tests/test-fifo-preservation.js`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)
    - _Requirements: 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all test suites:
    - `node tests/test-fifo-bug-condition.js` (should PASS)
    - `node tests/test-fifo-preservation.js` (should PASS)
    - `node tests/test-preservation-properties.js` (existing tests, should still PASS)
  - Ensure all tests pass, ask the user if questions arise.
