# Implementation Plan

- [x] 1. 编写 bug condition 探索测试
  - **Property 1: Bug Condition** - SIGTERM 吸收路径缺少 FIFO 备用控制通道
  - **CRITICAL**: 此测试必须在修复前运行——测试 1-3 FAIL 确认 bug 存在，测试 4 PASS 确认基线行为
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: 此测试编码了期望行为——修复后测试 1-3 将 PASS，验证修复正确性
  - **GOAL**: 通过代码检查和行为测试，确认 SIGTERM 吸收路径中缺少 FIFO 建立逻辑
  - 创建 `tests/test-session-recovery-bug-condition.js`
  - 测试 1（代码检查）：读取 bridge 源码，检查 `gracefulShutdown()` 的 `deferred: true` 分支附近是否有 `setupFifoControl` 调用——unfixed 代码中缺少，FAIL
  - 测试 2（代码检查）：验证 bridge 源码中是否存在 `fifoFallbackCreated` 变量——unfixed 代码中缺少，FAIL
  - 测试 3（代码检查）：验证 `control_channel` 事件中是否有 `reason` 字段（在 `deferred: true` 分支附近）——unfixed 代码中缺少，FAIL
  - 测试 4（行为基线）：启动 bridge（无 session）→ 发送 SIGTERM → 验证 bridge 立即 shutdown——PASS（基线确认）
  - 测试 helper 必须过滤 stdout 中的 `control_channel`、`heartbeat`、`bridge_signal_received` 事件
  - 在 UNFIXED 代码上运行测试
  - **EXPECTED OUTCOME**: 测试 1-3 FAIL（确认 bug 存在），测试 4 PASS（基线行为正常）
  - 记录发现的 counterexample（如 `deferred: true` 分支在 `return` 前没有 FIFO 相关逻辑）
  - 任务完成条件：测试已编写、运行、failure 已记录
  - _Requirements: 1.1, 1.2, 1.4, 2.1, 2.2_

- [x] 2. 编写 preservation 属性测试（修复前运行）
  - **Property 2: Preservation** - 非 SIGTERM 吸收路径行为不变
  - **IMPORTANT**: 遵循 observation-first 方法论
  - 创建 `tests/test-session-recovery-preservation.js`
  - 观察 UNFIXED 代码上的行为并编写测试：
  - 测试 1：stdio 正常运行——启动 bridge → 发送 `{"op":"ping"}` → 验证 pong 响应格式正确（type=pong, pid=null, ready=false, session, initializeResult=null, sessions）
  - 测试 2：SIGINT 立即 shutdown——启动 bridge → 发送 SIGINT → 验证 shutdown 事件（reason=SIGINT）
  - 测试 3：op:stop 立即终止——发送 `{"op":"stop"}` → 验证 stop_requested 响应
  - 测试 4：ping/pong 无 controlMode/controlPath 字段——验证 stdio 模式下 pong 响应不含 FIFO 相关字段
  - 测试 5：unknown op 错误处理——发送 `{"op":"unknown_op"}` → 验证 bridge_error 响应
  - 测试 6：invalid JSON 错误处理——发送 `not json` → 验证 bridge_error 响应
  - 测试 7：bridge_signal_received 事件字段完整——发送 SIGTERM → 验证事件含 signal、pendingCalls、timestamp 字段
  - 测试 helper 必须过滤 stdout 中的 `control_channel`、`heartbeat`、`bridge_signal_received` 事件（检查命令响应时）
  - 在 UNFIXED 代码上运行测试
  - **EXPECTED OUTCOME**: 所有测试 PASS（确认基线行为，修复后必须保持不变）
  - 任务完成条件：测试已编写、运行、全部 PASS
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

- [x] 3. 修复 SIGTERM 吸收路径缺少 FIFO 备用控制通道

  - [x] 3.1 新增 `fifoFallbackCreated` 状态变量
    - 在 `scripts/kiro-acp-bridge.js` 顶层变量区域添加 `let fifoFallbackCreated = false;`
    - 此 flag 标记是否已通过 SIGTERM 吸收路径或 stdin EOF 创建了 FIFO fallback，防止重复创建
    - _Bug_Condition: isBugCondition(input) where input.controlMode == 'stdio' AND input.sigTermAbsorbed == true AND input.fifoFallbackCreated == false_
    - _Requirements: 2.1, 2.3_

  - [x] 3.2 在 SIGTERM 吸收路径中添加 FIFO 创建逻辑
    - 修改 `gracefulShutdown()` 的 `deferred: true` 分支
    - 在现有 `return;` 之前添加：当 `controlMode === 'stdio'` 时，调用 `setupFifoControl(fallbackPath)` 建立 FIFO
    - 设置 `fifoFallbackCreated = true`
    - 输出 `control_channel` 事件含 `reason: "sigterm_recovery"`
    - 用 try/catch 包裹，失败时输出 bridge_error
    - _Expected_Behavior: SIGTERM 吸收后立即建立 FIFO 备用控制通道_
    - _Preservation: controlMode === 'fifo' 时不创建，无活跃 session 时不进入此分支_
    - _Requirements: 2.1, 2.2, 3.4_

  - [x] 3.3 在 stdin EOF handler 中添加 `fifoFallbackCreated` 防护
    - 修改 `rl.on('close', ...)` handler
    - 在创建 FIFO 之前检查 `fifoFallbackCreated` flag
    - 如果已创建，输出 info 日志并跳过 FIFO 创建
    - 如果未创建，执行现有逻辑并设置 `fifoFallbackCreated = true`
    - _Expected_Behavior: 防止 SIGTERM 吸收后 stdin EOF 重复创建 FIFO_
    - _Preservation: 首次 stdin EOF（无 SIGTERM 吸收）行为不变_
    - _Requirements: 2.3, 3.2_

  - [x] 3.4 扩展 graceful shutdown 的 FIFO 清理逻辑
    - 在 `gracefulShutdown()` 中现有 FIFO 清理（`controlMode === 'fifo' && controlPath`）之后
    - 添加：如果 `fifoFallbackCreated`，清理 `/tmp/kiro-acp-bridge-${process.pid}.fifo`
    - _Preservation: 现有 FIFO 清理逻辑不变，新增 SIGTERM 吸收路径创建的 FIFO 清理_
    - _Requirements: 3.9_

  - [x] 3.5 更新 `references/acp-bridge-protocol.md` 文档
    - 在 Bridge-emitted events 部分添加 `control_channel` 事件文档
    - 说明 `reason: "sigterm_recovery"` 字段含义
    - 说明 SIGTERM 吸收后的 FIFO 恢复路径
    - 不修改 SKILL.md（setsid 已在 bugfix #5 中添加）
    - _Requirements: 2.2_

  - [x] 3.6 验证 bug condition 探索测试现在通过
    - **Property 1: Expected Behavior** - SIGTERM 吸收后建立 FIFO 备用控制通道
    - **IMPORTANT**: 重新运行任务 1 中的同一测试——不要编写新测试
    - 运行 `node tests/test-session-recovery-bug-condition.js`
    - **EXPECTED OUTCOME**: 测试 1-3 PASS（确认 bug 已修复），测试 4 PASS（基线行为不变）
    - _Requirements: 2.1, 2.2_

  - [x] 3.7 验证 preservation 测试仍然通过
    - **Property 2: Preservation** - 非 SIGTERM 吸收路径行为不变
    - **IMPORTANT**: 重新运行任务 2 中的同一测试——不要编写新测试
    - 运行 `node tests/test-session-recovery-preservation.js`
    - **EXPECTED OUTCOME**: 所有测试 PASS（确认无回归）
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 3.8 验证现有 test-sigterm-resilience-bug-condition.js 通过
    - 运行 `node tests/test-sigterm-resilience-bug-condition.js`
    - **EXPECTED OUTCOME**: 所有 4 个测试 PASS（sigterm-resilience 修复未被破坏）
    - _Requirements: 3.5, 3.6_

  - [x] 3.9 验证现有 test-sigterm-resilience-preservation.js 通过
    - 运行 `node tests/test-sigterm-resilience-preservation.js`
    - **EXPECTED OUTCOME**: 所有 7 个测试 PASS（sigterm-resilience 保持行为不变）
    - _Requirements: 3.1, 3.3, 3.5, 3.7_

- [x] 4. Checkpoint — 确保所有测试通过
  - 运行所有 10 个测试套件（50+ 测试），确保无回归：
  - `node tests/test-session-recovery-bug-condition.js`（本次新增）
  - `node tests/test-session-recovery-preservation.js`（本次新增）
  - `node tests/test-sigterm-resilience-bug-condition.js`
  - `node tests/test-sigterm-resilience-preservation.js`
  - `node tests/test-fifo-bug-condition.js`
  - `node tests/test-fifo-preservation.js`
  - `node tests/test-signal-bug-condition.js`
  - `node tests/test-signal-preservation.js`
  - `node tests/test-bug-condition-exploration.js`
  - `node tests/test-preservation-properties.js`
  - 如有问题，询问用户
