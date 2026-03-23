# Bridge Stdio Lifecycle 文档修复设计

## 概述

ACP bridge 以 `exec(background:true)` 启动时，OpenClaw 分配的 stdin 管道几乎立刻 EOF，导致 process session 在 25ms 内标记为 `failed`，后续所有 `process action:submit` 均失败。

Bridge 本身没有问题——FIFO 控制通道（bugfix #4 已实现）完全可用。问题在于 SKILL.md 和 `references/acp-bridge-protocol.md` 中的启动命令和工作流仍然使用 stdio 模式 + `process action:submit`。

修复方案：纯文档变更。将启动命令加上 `--control fifo`，将所有 `process action:submit` 替换为 FIFO 写入（`echo '...' > /tmp/kiro-acp-bridge-PID.fifo`），保留 `process action:log` 用于读取输出。Bridge 代码不做任何修改。

## 术语表

- **Bug_Condition (C)**：SKILL.md 和 acp-bridge-protocol.md 中使用 `process action:submit` 作为命令发送方式，且启动命令不包含 `--control fifo`
- **Property (P)**：启动命令包含 `--control fifo`，命令发送通过 FIFO 写入
- **Preservation**：Bridge 代码不变，63 个测试全部通过，stdio 模式仍然可用（只是不再作为文档中的默认方式）
- **FIFO 控制通道**：Bridge 在 `--control fifo` 模式下创建的命名管道 `/tmp/kiro-acp-bridge-PID.fifo`，用于接收 JSONL 命令
- **`control_channel` 事件**：Bridge 启动后在 stdout 输出的事件，包含 FIFO 路径，agent 通过 `process action:log` 获取

## Bug 详情

### Bug Condition

当 SKILL.md 和 acp-bridge-protocol.md 中的工作流使用 `process action:submit`（依赖 stdio）发送命令，且启动命令不包含 `--control fifo` 时，在 OpenClaw background process stdin 不可靠的环境下，整个工作流不可用。

**形式化规范：**
```
FUNCTION isBugCondition(doc)
  INPUT: doc — SKILL.md 或 acp-bridge-protocol.md 的内容
  OUTPUT: boolean

  hasStdioLaunch := doc 中的 bridge 启动命令不包含 "--control fifo"
  hasProcessSubmit := doc 中使用 "process action:submit" 发送控制命令

  RETURN hasStdioLaunch AND hasProcessSubmit
END FUNCTION
```

### 示例

- SKILL.md Step 1 启动命令 `setsid node ... kiro-acp-bridge.js`（无 `--control fifo`）→ bridge 以 stdio 模式启动 → stdin EOF → session failed
- SKILL.md Step 2 `process action:submit sessionId:XXX input:'{"op":"start",...}'` → OpenClaw session 已 failed → "No active session found"
- acp-bridge-protocol.md 多轮工作流示例同样使用 `process action:submit` → 同样失败
- 用户手动通过 FIFO 发送命令 → 成功（证明 bridge 本身没问题）

## 预期行为

### Preservation 要求

**不变行为：**
- Bridge 代码（`scripts/kiro-acp-bridge.js`）不做任何修改
- Bridge 的 FIFO 控制通道功能行为不变（JSONL 解析、EOF 重开、shutdown 清理）
- Bridge 的 stdio 模式仍然可用（`--control stdio` 或不指定 `--control`）
- Bridge 的信号处理（SIGTERM 吸收、grace period）不变
- Bridge 的心跳、状态保存、自动通知不变
- 现有 63 个测试全部通过
- `process action:log` 继续用于读取 bridge stdout 输出

**范围：**
所有不涉及 SKILL.md 和 acp-bridge-protocol.md 中启动命令和命令发送方式的内容不受影响。

## 假设根因

基于 bug 分析，根因明确：

1. **文档滞后**：FIFO 控制通道在 bugfix #4 (bridge-control-channel) 中实现，但 SKILL.md 和 acp-bridge-protocol.md 未同步更新，仍然使用 stdio 模式的工作流
2. **OpenClaw background process stdin 生命周期不可靠**：`exec(background:true)` 启动的进程，stdin 管道几乎立刻 EOF，这是 OpenClaw 平台行为，不是 bridge 的 bug
3. **`process action:submit` 依赖 stdio session 存活**：当 session 标记为 `failed` 后，submit 无法送达

根因不在代码中，而在文档中——文档指示了一个在 OpenClaw background process 环境下不可靠的工作流。

## 正确性属性

Property 1: Bug Condition — 文档使用 FIFO 模式

_For any_ SKILL.md 或 acp-bridge-protocol.md 中的 bridge 工作流，启动命令 SHALL 包含 `--control fifo` 参数，命令发送 SHALL 使用 FIFO 写入（`echo '...' > FIFO_PATH`）而非 `process action:submit`。

**验证: 需求 2.1, 2.2, 2.3**

Property 2: Preservation — Bridge 代码和测试不变

_For any_ bridge 代码文件和测试文件，修复后 SHALL 与修复前完全一致（字节级相同），所有 63 个测试 SHALL 继续通过。`process action:log` SHALL 继续用于读取 bridge 输出。

**验证: 需求 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**

## 修复实现

### 需要的变更

假设根因分析正确（文档滞后）：

**文件**: `SKILL.md`

**变更 1 — 启动命令加 `--control fifo`**：

所有 bridge 启动命令从：
```bash
setsid node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js
```
改为：
```bash
setsid node ~/.openclaw/workspace/skills/kiro-agent/scripts/kiro-acp-bridge.js --control fifo
```

**变更 2 — 新增 Step: 获取 FIFO 路径**：

启动后立即通过 `process action:log` 读取 `control_channel` 事件获取 FIFO 路径：
```bash
process action:log sessionId:XXX
# 查找: {"type":"control_channel","mode":"fifo","path":"/tmp/kiro-acp-bridge-PID.fifo"}
```

**变更 3 — 命令发送从 `process action:submit` 改为 FIFO 写入**：

所有 `process action:submit sessionId:XXX input:'...'` 改为：
```bash
echo '{"op":"start","agent":"kiro_default","model":"claude-opus-4.6","trustAllTools":true}' > /tmp/kiro-acp-bridge-PID.fifo
```

**变更 4 — 保留 `process action:log`**：

读取 bridge 输出继续使用 `process action:log sessionId:XXX`（bridge stdout 不受控制通道模式影响）。

**变更 5 — 更新 session continuity check 中的 bridge 交互**：

Step 2a 中与运行中 bridge 交互的方式从 `process action:submit` 改为 FIFO 写入。

---

**文件**: `references/acp-bridge-protocol.md`

**变更 6 — 多轮工作流示例更新**：

"OpenClaw integration workflow" 部分的所有 `process action:submit` 改为 FIFO 写入，启动命令加 `--control fifo`，新增获取 FIFO 路径的步骤。

**变更 7 — 一次性工作流示例更新**：

"One-shot-via-bridge" 部分同样更新。

### 新工作流模式

完整的新工作流：

1. **启动 bridge**（background process，加 `--control fifo`）
2. **读取日志获取 FIFO 路径**（`process action:log` → 找 `control_channel` 事件）
3. **通过 FIFO 写入命令**（`echo '{"op":"start",...}' > FIFO_PATH`）
4. **读取日志获取输出**（`process action:log` → 找 `ready`、`session_update`、`prompt_completed` 等事件）
5. 重复 3-4 进行多轮交互

## 测试策略

### 验证方法

由于这是纯文档变更，测试策略侧重于文档内容验证和 bridge 代码/测试的 preservation 检查。

### 探索性 Bug Condition 检查

**目标**：在修复前确认 bug condition 存在——SKILL.md 和 acp-bridge-protocol.md 中确实使用 `process action:submit` 且不包含 `--control fifo`。

**测试计划**：扫描文档内容，验证 bug condition 成立。

**测试用例**：
1. **SKILL.md 启动命令检查**：确认启动命令不包含 `--control fifo`（修复前应失败）
2. **SKILL.md submit 检查**：确认存在 `process action:submit` 用于发送控制命令（修复前应失败）
3. **acp-bridge-protocol.md 启动命令检查**：同上（修复前应失败）
4. **acp-bridge-protocol.md submit 检查**：同上（修复前应失败）

**预期反例**：
- 文档中存在多处 `process action:submit` 用于发送控制命令
- 启动命令均不包含 `--control fifo`

### Fix Checking

**目标**：验证修复后，所有 bug condition 输入都产生预期行为。

**伪代码：**
```
FOR ALL doc IN [SKILL.md, references/acp-bridge-protocol.md] DO
  launchCommands := 提取 doc 中的 bridge 启动命令
  FOR ALL cmd IN launchCommands DO
    ASSERT cmd 包含 "--control fifo"
  END FOR

  commandDelivery := 提取 doc 中的命令发送指令
  FOR ALL delivery IN commandDelivery DO
    ASSERT delivery 使用 FIFO 写入（echo ... > FIFO_PATH）
    ASSERT delivery 不使用 "process action:submit" 发送控制命令
  END FOR

  logReading := 提取 doc 中的输出读取指令
  FOR ALL reading IN logReading DO
    ASSERT reading 使用 "process action:log"
  END FOR
END FOR
```

### Preservation Checking

**目标**：验证 bridge 代码和测试文件在修复前后完全一致。

**伪代码：**
```
FOR ALL file IN [scripts/kiro-acp-bridge.js, tests/*] DO
  ASSERT checksum_before(file) = checksum_after(file)
END FOR

RUN 全部 63 个测试
ASSERT 全部通过
```

**测试方法**：使用文件校验和（SHA256）验证代码文件未被修改，运行完整测试套件确认无回归。

**测试用例**：
1. **Bridge 代码 preservation**：`scripts/kiro-acp-bridge.js` 的 SHA256 修复前后一致
2. **测试文件 preservation**：`tests/` 目录下所有文件的 SHA256 修复前后一致
3. **测试通过 preservation**：63 个测试全部通过

### 单元测试

- 扫描 SKILL.md 中的 bridge 启动命令，验证包含 `--control fifo`
- 扫描 SKILL.md 中的命令发送方式，验证使用 FIFO 写入
- 扫描 acp-bridge-protocol.md 中的工作流示例，验证同上
- 验证 `process action:log` 仍用于读取输出

### 属性测试

- 对 SKILL.md 和 acp-bridge-protocol.md 中提取的所有代码块，验证不存在 `process action:submit` 用于发送控制命令
- 对所有 bridge 启动命令，验证包含 `--control fifo`
- 对 bridge 代码和测试文件，验证字节级不变

### 集成测试

- 按新工作流（启动 → 读日志获取 FIFO 路径 → FIFO 写入 → 读日志获取输出）端到端验证
- 验证 `control_channel` 事件正确输出 FIFO 路径
- 验证通过 FIFO 发送的命令被 bridge 正确处理
