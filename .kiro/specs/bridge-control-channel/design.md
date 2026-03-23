# Bridge Control Channel Bugfix Design

## Overview

`kiro-acp-bridge.js` 当前仅支持 stdin 作为控制通道，但在 OpenClaw `exec(background:true)` 场景下 stdin 不可靠（pipe 提前关闭、宿主回收进程）。上一个 bugfix（bridge-process-stability）已解决 stdin EOF 后进程退出的问题，但进程存活不等于可控——stdin 断开后 bridge 成为不可控的僵尸状态。

FIFO workaround 已验证成功：用 named pipe 替代 stdin 完成了完整的 start → session_new → send → prompt_completed 流程。本次修复将 FIFO 控制通道原生集成到 bridge 中，通过 `--control fifo` 命令行参数启用，同时保持 `--control stdio`（默认）的向后兼容。

核心设计要点：
- 命令行参数解析：`--control stdio|fifo` 和 `--control-path <path>`
- FIFO 模式：创建 named pipe → 从 FIFO 读取 JSONL → EOF 后重新打开（持续可用）
- 命令处理逻辑复用：FIFO 和 stdin 共享同一个 `processCommand(line)` 函数
- graceful shutdown 时清理 FIFO 文件

## Glossary

- **Bug_Condition (C)**: bridge 以 `exec(background:true)` 启动后 stdin 控制通道不可靠，导致命令无法送达或 ACP 子进程被终止
- **Property (P)**: FIFO 模式下控制通道在 bridge 整个生命周期内持续可用，命令处理行为与 stdin 模式一致
- **Preservation**: 现有 stdin 模式的所有行为（JSONL 命令处理、ACP 管理、事件转发、graceful shutdown、心跳）必须保持不变
- **bridge**: `scripts/kiro-acp-bridge.js`，OpenClaw 与 Kiro ACP 之间的传输层
- **FIFO (named pipe)**: Unix named pipe，通过 `mkfifo` 创建的文件系统对象，支持多个写入者顺序写入，读取端在写入端关闭后收到 EOF 但可重新打开
- **控制通道**: bridge 接收 JSONL 命令的输入源，可以是 stdin（stdio 模式）或 named pipe（fifo 模式）
- **EOF 重连**: FIFO 模式下写入端关闭后，bridge 重新打开 FIFO 等待下一个写入者的机制

## Bug Details

### Bug Condition

Bug 在以下场景中触发：bridge 通过 `exec(background:true)` 启动后，stdin pipe 被宿主关闭或不可写，导致 (A) 后续 JSONL 命令报 `write after end` 无法送达，或 (B) 宿主因 stdin 断开/idle 检测回收进程导致 ACP 子进程被 SIGTERM。上一个 bugfix 的 keepalive timer 保证了进程不退出，但 bridge 失去了接收命令的能力，成为不可控的僵尸状态。

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { launchMode: string, stdinState: string, commandDelivery: string }
  OUTPUT: boolean

  // 核心条件：background exec + stdin 不可靠
  RETURN input.launchMode == 'background_exec'
         AND input.stdinState IN ['closed', 'write_after_end', 'eof']
         AND input.commandDelivery == 'failed'
         AND controlMode == 'stdio'  // 仅 stdio 模式受影响
END FUNCTION
```

### Examples

- **Failure Mode A**: `exec(background:true)` 启动 bridge → 宿主尝试 `process submit` 发送 `{"op":"start",...}` → 返回 `write after end` → 命令未送达（期望：命令通过 FIFO 可靠送达）
- **Failure Mode B**: bridge 通过 stdin 成功启动并进入 prompt 执行 → 宿主因 stdin 断开/idle 检测发送 SIGTERM → ACP 子进程在 `session/prompt` 执行中被终止（期望：FIFO 控制通道独立于 stdin 生命周期）
- **僵尸状态**: stdin EOF 后 bridge 进程存活（keepalive timer 生效）但无法接收任何命令 → 用户无法 send/stop/ping（期望：FIFO 模式下控制通道持续可用）
- **FIFO EOF 重连**: 外部进程向 FIFO 写入命令后关闭 fd → FIFO 读取端收到 EOF → bridge 重新打开 FIFO 等待下一个写入者（期望：不终止控制通道）

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `--control stdio`（默认）模式下所有现有行为完全不变：JSONL 命令处理、ACP 子进程管理、事件转发、权限自动处理
- ACP 子进程正常/异常退出时的 exit 事件、pending promise 清理、状态保存、用户通知
- SIGTERM/SIGINT 信号触发的 graceful shutdown 流程
- `session/update` 通知和 `session/request_permission` 请求的处理和转发
- 心跳事件的定期输出
- `ping` 命令返回包含 pid、ready、session 信息的 pong 响应

**Scope:**
所有不涉及控制通道初始化和输入源选择的行为应完全不受此修复影响。包括：
- ACP JSON-RPC 通信（bridge → kiro-cli acp）
- 状态文件读写
- 用户通知（openclaw system event）
- stdout 事件输出格式（除新增的 `control_channel` 事件外）

## Hypothesized Root Cause

基于 bug report 和代码分析，根因如下：

1. **控制通道与 stdin 生命周期耦合**: bridge 硬编码使用 `readline.createInterface({ input: process.stdin })` 作为唯一命令输入源。OpenClaw `exec(background:true)` 不保证 stdin 持久可写，导致控制通道契约不匹配。

2. **缺少替代控制通道**: bridge 没有提供 stdin 以外的命令输入机制。FIFO workaround 已证明 named pipe 可以作为可靠的替代方案，但需要原生集成而非手动 shell 重定向。

3. **缺少命令行参数解析**: 当前 bridge 不接受任何命令行参数，无法在启动时选择控制通道模式。

4. **FIFO EOF 语义差异未处理**: FIFO 的 EOF 语义与 stdin 不同——FIFO 写入端关闭后读取端收到 EOF，但可以重新打开等待下一个写入者。bridge 需要实现 EOF 后重新打开的循环。

## Correctness Properties

Property 1: Bug Condition - FIFO 控制通道可靠接收命令

_For any_ bridge 以 `--control fifo` 模式启动的情况下，外部进程向 FIFO 写入有效的 JSONL 命令时，bridge SHALL 正确解析并执行对应的 ACP 操作（start、session_new、send 等），行为与 stdin 模式完全一致，且不依赖 stdin 的生命周期。

**Validates: Requirements 2.1, 2.2**

Property 2: Bug Condition - FIFO EOF 后重新打开

_For any_ bridge 以 `--control fifo` 模式运行且 FIFO 写入端关闭（EOF）的情况下，bridge SHALL 重新打开 FIFO 等待下一个写入者，控制通道在 bridge 整个生命周期内持续可用。

**Validates: Requirements 2.4**

Property 3: Preservation - stdio 模式行为不变

_For any_ bridge 未指定 `--control` 参数或指定 `--control stdio` 的情况下，bridge SHALL 产生与修复前完全相同的行为，保持所有现有 stdin 控制通道逻辑、JSONL 命令处理、ACP 管理、事件转发、graceful shutdown、心跳输出不变。

**Validates: Requirements 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**


## Fix Implementation

### Changes Required

假设根因分析正确，所有修改集中在 `scripts/kiro-acp-bridge.js` 一个文件：

**File**: `scripts/kiro-acp-bridge.js`

**Specific Changes**:

1. **添加命令行参数解析**:
   - 解析 `process.argv` 提取 `--control <stdio|fifo>` 和 `--control-path <path>`
   - 默认值：`--control stdio`，`--control-path /tmp/kiro-acp-bridge-<pid>.fifo`
   - 简单的 argv 遍历即可，不需要引入外部依赖

   ```javascript
   function parseArgs(argv) {
     let controlMode = 'stdio';
     let controlPath = null;
     for (let i = 2; i < argv.length; i++) {
       if (argv[i] === '--control' && argv[i + 1]) {
         controlMode = argv[++i];
       } else if (argv[i] === '--control-path' && argv[i + 1]) {
         controlPath = argv[++i];
       }
     }
     if (controlMode === 'fifo' && !controlPath) {
       controlPath = `/tmp/kiro-acp-bridge-${process.pid}.fifo`;
     }
     return { controlMode, controlPath };
   }
   ```

2. **提取命令处理函数（复用逻辑）**:
   - 将现有 `rl.on('line', async (line) => { ... })` 中的命令分发逻辑提取为独立的 `async function processCommand(line)` 函数
   - stdin 模式和 FIFO 模式共享同一个 `processCommand` 函数
   - 这是最小化改动的关键——命令解析和执行逻辑完全复用

   ```javascript
   async function processCommand(line) {
     if (!line.trim()) return;
     let msg;
     try {
       msg = JSON.parse(line);
     } catch {
       emit({ type: 'bridge_error', message: 'Invalid JSON input' });
       return;
     }
     try {
       switch (msg.op) {
         case 'start': await startAcp(msg); break;
         case 'session_new': await createSession(msg); break;
         // ... 其余 case 保持不变
       }
     } catch (err) {
       emit({ type: 'bridge_error', op: msg.op, message: String(err?.message || err) });
     }
   }
   ```

3. **实现 FIFO 控制通道**:
   - 使用 `child_process.execFileSync('mkfifo', [controlPath])` 创建 named pipe
   - 实现 `openFifoReader()` 函数：以只读方式打开 FIFO（`fs.createReadStream`），创建 readline 接口，注册 line 和 close 事件
   - close 事件（EOF）时：销毁当前 stream，延迟后重新调用 `openFifoReader()` 实现 EOF 重连
   - 关键：FIFO 的 `open()` 会阻塞直到有写入者连接，所以使用 `fs.createReadStream` 的异步模式

   ```javascript
   function setupFifoControl(fifoPath) {
     // 创建 FIFO 文件
     require('node:child_process').execFileSync('mkfifo', [fifoPath]);

     function openFifoReader() {
       const stream = fs.createReadStream(fifoPath, { encoding: 'utf8' });
       const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

       rl.on('line', (line) => processCommand(line));

       rl.on('close', () => {
         stream.destroy();
         // EOF 后重新打开，等待下一个写入者
         emit({ type: 'info', message: 'FIFO EOF, reopening for next writer' });
         setImmediate(() => openFifoReader());
       });

       stream.on('error', (err) => {
         emit({ type: 'bridge_error', message: `FIFO read error: ${err.message}` });
       });
     }

     openFifoReader();
   }
   ```

4. **启动时输出 `control_channel` 事件**:
   - FIFO 模式启动后立即输出 `{"type":"control_channel","mode":"fifo","path":"/path/to/fifo"}`
   - stdio 模式输出 `{"type":"control_channel","mode":"stdio"}`
   - 调用方据此知道如何向 bridge 发送命令

5. **graceful shutdown 时清理 FIFO 文件**:
   - 在现有 `gracefulShutdown()` 函数中添加 FIFO 清理逻辑
   - `fs.unlinkSync(controlPath)` 删除 FIFO 文件（忽略 ENOENT 错误）

   ```javascript
   async function gracefulShutdown(reason) {
     if (shuttingDown) return;
     shuttingDown = true;
     clearInterval(heartbeatTimer);

     // 清理 FIFO 文件
     if (controlMode === 'fifo' && controlPath) {
       try { fs.unlinkSync(controlPath); } catch {}
     }

     // ... 现有 shutdown 逻辑保持不变
   }
   ```

6. **扩展 ping/pong 响应**:
   - FIFO 模式下 pong 响应额外包含 `controlMode` 和 `controlPath` 字段
   - 满足需求 3.6 的要求

7. **控制通道初始化分支**:
   - 在文件末尾（原 `rl` 创建位置），根据 `controlMode` 选择初始化路径：
     - `stdio`: 保持现有 `readline.createInterface({ input: process.stdin })` 逻辑不变
     - `fifo`: 调用 `setupFifoControl(controlPath)`，stdin 不再用于命令输入

## Testing Strategy

### Validation Approach

测试策略分两阶段：先在未修复代码上验证 bug 存在（exploratory），再在修复后验证 FIFO 模式正确性和 stdio 模式行为保持。

### Exploratory Bug Condition Checking

**Goal**: 在未修复代码上确认 bridge 缺少 FIFO 支持，验证 stdin 控制通道在 background exec 场景下的不可靠性。

**Test Plan**: 编写测试脚本验证当前 bridge 不支持 `--control fifo` 参数，且 stdin 关闭后无法接收命令。

**Test Cases**:
1. **参数不支持测试**: 启动 `node kiro-acp-bridge.js --control fifo`，验证 bridge 忽略参数仍使用 stdin（will fail on unfixed code — 无 FIFO 支持）
2. **stdin 关闭后不可控测试**: 启动 bridge → 关闭 stdin → 尝试发送命令 → 验证命令无法送达（will fail on unfixed code — bridge 成为僵尸）
3. **FIFO 手动 workaround 测试**: 手动创建 FIFO → `node bridge.js < fifo` → 向 FIFO 写入命令 → 验证命令被处理（will pass — 证明 FIFO 方案可行）

**Expected Counterexamples**:
- `--control fifo` 参数被忽略，bridge 仍从 stdin 读取
- stdin 关闭后 `ping` 命令无法送达，无 `pong` 响应
- 手动 FIFO 重定向可以工作，证明问题在 bridge 缺少原生 FIFO 支持

### Fix Checking

**Goal**: 验证修复后，FIFO 模式下控制通道可靠工作。

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  // 启动 bridge 以 --control fifo 模式
  bridge := start_bridge('--control', 'fifo')

  // 验证 control_channel 事件输出
  ASSERT bridge.stdout CONTAINS {"type":"control_channel","mode":"fifo","path":...}

  // 向 FIFO 写入命令
  write_to_fifo(bridge.controlPath, input.command)

  // 验证命令被正确处理
  result := read_bridge_stdout()
  ASSERT expectedBehavior(result, input.command)
END FOR
```

### Preservation Checking

**Goal**: 验证修复后，stdio 模式的所有行为与修复前完全一致。

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  // stdio 模式（默认）
  ASSERT bridge_original(input) = bridge_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing 适合 preservation checking，因为：
- 可以自动生成大量合法 JSONL 命令组合验证 stdio 模式不变
- 能覆盖命令顺序、参数组合的边界情况
- 对所有非 FIFO 相关输入提供强保证

**Test Plan**: 先在未修复代码上记录 stdio 模式各命令的响应行为作为基准，然后在修复后验证响应一致。

**Test Cases**:
1. **stdio 命令响应保持**: 验证默认模式下 start、session_new、send、ping 等命令的响应格式和内容不变
2. **ACP 退出处理保持**: 验证 ACP 子进程退出时的 exit 事件、状态保存、通知行为不变
3. **graceful shutdown 保持**: 验证 SIGTERM/SIGINT 信号处理流程不变
4. **心跳输出保持**: 验证 heartbeat 事件格式和间隔不变
5. **ping/pong 保持**: 验证 stdio 模式下 ping 响应包含所有预期字段（不含 controlMode/controlPath）

### Unit Tests

- 测试 `parseArgs()` 函数：默认值、`--control stdio`、`--control fifo`、`--control-path` 自定义路径、无效参数
- 测试 `processCommand()` 函数：各 op 的正确分发（从 rl.on('line') 提取后的独立函数）
- 测试 FIFO 创建和清理：`mkfifo` 调用、`unlinkSync` 清理、ENOENT 容错
- 测试 `control_channel` 事件输出格式：fifo 模式包含 path、stdio 模式不含 path
- 测试 FIFO EOF 重连逻辑：写入端关闭后 bridge 重新打开 FIFO
- 测试 pong 响应扩展：fifo 模式包含 controlMode 和 controlPath 字段

### Property-Based Tests

- 生成随机 JSONL 命令序列，验证 stdio 模式下修复后响应与修复前一致（preservation）
- 生成随机 FIFO 写入/关闭/重新写入序列，验证 FIFO 控制通道始终可用（fix checking）
- 生成随机命令行参数组合，验证 `parseArgs()` 始终返回有效配置
- 测试 FIFO EOF 重连在各种时序下的稳定性（写入者快速连接/断开）

### Integration Tests

- 完整 FIFO 模式流程：`--control fifo` 启动 → 读取 control_channel 事件 → 向 FIFO 写入 start → 验证 ready → session_new → send → prompt_completed → stop → 验证 FIFO 文件已清理
- FIFO EOF 重连集成测试：向 FIFO 写入命令 → 关闭写入端 → 重新打开 FIFO 写入新命令 → 验证两次命令都被处理
- stdio 模式回归测试：不带 `--control` 参数启动 → 验证行为与修复前完全一致
- graceful shutdown + FIFO 清理：`--control fifo` 启动 → SIGTERM → 验证 FIFO 文件已删除 + ACP 子进程已关闭
- 自定义路径测试：`--control fifo --control-path /tmp/custom.fifo` → 验证使用指定路径
