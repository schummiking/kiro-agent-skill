# Kiro Session Routing 修复设计文档

## 概述

本修复解决 kiro-agent skill 中传输路由的架构性问题。经过两轮事件分析（2026-03-22 初始事件 + 后续 bug report `references/acp-bug-report-2026-03-22.md`），问题比最初预期更深层——不仅是"bridge 未被定位为统一传输层"，而是三重缺陷叠加：

1. **CLI 非交互作为 fallback 不应存在**：保留 CLI 给了 agent 不走 bridge 的借口。Bridge 是唯一传输层——bridge 失败是 bug，不是需要 fallback 的场景。
2. **约束力度不够**：推荐性措辞（"DEFAULT"/"OPTIONAL ALTERNATIVE"）在执行压力下被误读。需要升级为硬性禁令（"MANDATORY"/"PROHIBITED"）。
3. **三个 ACP 概念被混为一谈**：ACP 协议、direct ACP via `sessions_spawn`、ACP bridge-as-process 未被明确区分。

**核心架构决策：ACP bridge 是唯一传输层（MANDATORY）。没有 CLI fallback。** 理由：
- Bridge 处理 one-shot 同样高效：`session/new` → `session/prompt` → `prompt_completed` → `stop`
- Bridge one-shot 天然保留会话，CLI 非交互丢失这个能力
- 保留 CLI fallback 增加复杂性且给 agent 不走 bridge 的借口
- 如果 bridge 失败，那是需要修复的 bug，不是需要绕过的场景

修复策略是纯文档/skill 定义层面的变更。无需编写新脚本——`kiro-acp-bridge.js` 已存在且功能完整。

## 术语表

- **Bug_Condition (C)**：传输路由约束不够硬、三个 ACP 概念混为一谈、无 surface 能力预检、CLI fallback 不应存在
- **Property (P)**：ACP bridge 作为唯一传输层（MANDATORY），direct ACP spawn 在 Telegram 上被禁止（PROHIBITED），三个 ACP 概念明确区分
- **Preservation**：`sessions_spawn` ACP 作为桌面端可选替代、session continuity check 的前两条路径、通知契约、委派模式定义均保持可用
- **kiro-acp-bridge.js**：位于 `scripts/kiro-acp-bridge.js` 的 ACP 客户端桥接脚本
- **sessions_spawn**：OpenClaw 原生的会话创建机制，受 surface 线程绑定限制
- **exec(background:true)**：OpenClaw 的后台进程执行机制，不受 surface 线程绑定限制
- **kiro-acp-state.json**：bridge 的状态文件
- **one-shot-via-bridge**：通过 bridge 执行 one-shot 任务的模式
- **Surface Capability Pre-check**：在选择传输方式之前，强制检查当前 surface 的能力限制

## Bug 详情

### Bug Condition

传输路由存在三层问题：

**第一层（CLI fallback 不应存在）**：保留 CLI 非交互作为"紧急回退"给了 agent 不走 bridge 的借口，增加了不必要的路由复杂性。Bridge 是唯一传输层——如果 bridge 失败，那是需要修复的 bug。

**第二层（约束力度不够）**：skill 文档将 bridge 写为"DEFAULT"、`sessions_spawn` 写为"OPTIONAL ALTERNATIVE"。这种推荐性措辞在 2026-03-22 事件中被 agent 误读为"可以先试 direct ACP"。agent 在 Telegram 上先尝试了 `sessions_spawn(runtime:"acp")` 两次，bridge 从未被启动。

**第三层（三个 ACP 概念混为一谈）**：文档未明确区分 ACP 协议、direct ACP via `sessions_spawn`、ACP bridge-as-process。agent 将"用 ACP"理解为"先试 `sessions_spawn`"，而不是"用 ACP bridge"。

**形式化规约：**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { surface: string, scenario: string, skillDoc: SkillDocument }
  OUTPUT: boolean

  LET cliFallbackExists = input.skillDoc.transportRouting.containsCLIFallback()
  LET constraintsAreHard = input.skillDoc.containsHardProhibition("Telegram", "direct ACP spawn")
  LET threeConceptsSplit = input.skillDoc.containsSection("Three ACP concepts")
  LET surfacePreCheckExists = input.skillDoc.containsSection("Surface capability pre-check")
  LET bridgeIsMandatory = input.skillDoc.transportRouting.bridgeRole == "MANDATORY"
  LET oneShotViaBridgeDocumented = input.skillDoc.contains("one-shot-via-bridge")
  LET routingMatrixExists = input.skillDoc.contains("routing-matrix")

  // Bug condition 1: CLI fallback 仍然存在
  LET cliFallbackBug = cliFallbackExists

  // Bug condition 2: 约束不够硬
  LET softConstraintBug = NOT constraintsAreHard
                          OR NOT bridgeIsMandatory
                          OR NOT surfacePreCheckExists

  // Bug condition 3: 三个 ACP 概念未区分
  LET conceptConflationBug = NOT threeConceptsSplit

  // Bug condition 4: 缺少路由矩阵和 one-shot-via-bridge
  LET missingDocBug = NOT oneShotViaBridgeDocumented OR NOT routingMatrixExists

  RETURN cliFallbackBug OR softConstraintBug OR conceptConflationBug OR missingDocBug
END FUNCTION
```


### 示例

- **示例 1（2026-03-22 真实事件）**：agent 在 Telegram 上收到"用 Kiro review 这个 skill"→ 先尝试 `sessions_spawn(runtime:"acp")` → 缺少 `thread:true` 失败 → 加上 `thread:true` 再试 → Telegram 不支持 ACP thread spawn 失败 → bridge 从未被启动。正确行为：直接走 bridge，禁止在 Telegram 上尝试 direct ACP spawn
- **示例 2（one-shot 丢失上下文）**：agent 收到"用 Kiro 跑一下这个任务"→ 通过 CLI 非交互执行 → 任务完成 → 用户说"继续上次的"→ 无法恢复。正确行为：通过 bridge one-shot 模式执行，会话天然保留
- **示例 3（会话恢复）**：agent 收到"继续上次 Kiro 的任务"→ session continuity check 不检查 bridge 会话 → 无法找到 bridge 会话
- **示例 4（桌面端正常）**：agent 在桌面端执行多轮任务 → 可选 `sessions_spawn` ACP 或 bridge → 行为正确
- **示例 5（概念混淆）**：agent 看到"ACP 是主路"→ 理解为"先试 direct `sessions_spawn`"→ 在 Telegram 上失败。正确理解："用 ACP"意味着"用 ACP bridge"

## 期望行为

### Preservation 需求

**不变行为：**
- `sessions_spawn` ACP 在支持的 surface（桌面端、Web）上继续作为可选替代路径（bridge 为唯一默认）
- session continuity check 的前两条路径（`process action:list` 检查活跃进程、`kiro-cli chat --list-sessions` 检查 saved sessions）继续正常工作
- 通知契约（L1/L2/L3/L4 通知层）保持不变；bridge 已内置 L2+L3 通知
- 所有委派模式定义和 prompting 模板保持不变
- 输出交付规则（report file → Telegram attachment）保持不变

**被移除的行为（有意为之，非回归）：**
- CLI 非交互作为 fallback 路径被完全移除——这是有意的架构决策，不是回归
- transport routing 表中的 EMERGENCY FALLBACK 行被移除
- routing matrix 中的"bridge unavailable"行被移除

**范围：**
所有不涉及传输路由架构变更的场景不受此修复影响。

## 假设的根本原因

基于 bug 分析和 2026-03-22 事件复盘（含 `references/acp-bug-report-2026-03-22.md`），最可能的原因是：

1. **CLI fallback 的存在增加了不必要的复杂性**：保留 CLI 作为 fallback 意味着 agent 有两条路可走，增加了路由决策的复杂性。移除 CLI fallback 后，bridge 是唯一选择，路由决策变得简单明确。

2. **约束措辞不够防呆**：写了 bridge 是"DEFAULT"，也写了 `sessions_spawn` 是"OPTIONAL ALTERNATIVE"。但在执行压力下，agent 将"OPTIONAL ALTERNATIVE"误读为"可以先试"。需要升级为硬性禁令："MANDATORY"和"PROHIBITED"。

3. **三个 ACP 概念未被区分**：agent 将"ACP 是正路"收缩为"先试 direct `sessions_spawn(runtime:\"acp\")`"。实际上 ACP 协议、direct ACP spawn、ACP bridge 是三个不同的东西。

4. **缺少 surface 能力预检**：在选择传输方式之前，没有强制检查当前 surface 的能力限制。如果有预检步骤，agent 会先发现 Telegram 不支持 direct ACP spawn，直接走 bridge。

## 正确性属性

Property 1: Bug Condition — Bridge 作为唯一传输层 + 硬性禁令 + 三概念区分

_For any_ surface 和任务场景组合，修复后的 SKILL.md SHALL：(a) bridge 为唯一传输层（MANDATORY），无 CLI fallback；(b) 包含硬性禁令：Telegram 上禁止 direct ACP spawn；(c) 明确区分三个 ACP 概念；(d) 包含强制性 surface 能力预检；(e) one-shot-via-bridge 模式有完整工作流文档；(f) 路由矩阵覆盖所有 surface × scenario 组合。

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8**

Property 2: Preservation — 现有路径和行为可用

_For any_ 不涉及传输路由架构变更的场景（`sessions_spawn` ACP 作为可选替代、现有 session continuity check 的前两条路径、通知契约、委派模式），修复后的文档 SHALL 保持这些能力可用。注意：CLI 非交互路径被有意移除，这不是回归。

**Validates: Requirements 3.1, 3.2, 3.3, 3.4**

## 修复实现

### 所需变更

**文件**：`SKILL.md`

**变更 1 — 移除 CLI fallback，Bridge 为唯一传输层（MANDATORY）**：
- 从 transport routing 表中完全移除 EMERGENCY FALLBACK 行
- Bridge 标注为 MANDATORY（唯一传输层），不是 DEFAULT
- `sessions_spawn` ACP 标注为桌面端/Web 的可选替代（OPTIONAL，仅限支持的 surface）
- 无 CLI fallback——bridge 失败是 bug，不是需要绕过的场景

**变更 2 — 升级约束为硬性禁令**：
- 添加硬性禁令：「在 Telegram / chat surfaces 上：必须使用 ACP bridge。禁止尝试 direct ACP thread spawn。」
- 添加 Surface Capability Pre-check 作为强制性第一步
- 将措辞从推荐性（"DEFAULT"/"OPTIONAL"）升级为强制性（"MANDATORY"/"PROHIBITED"）

**变更 3 — 明确区分三个 ACP 概念**：
- 添加"三个 ACP 概念"章节，明确区分：
  1. ACP 协议——JSON-RPC 协议本身，surface 无关
  2. Direct ACP via `sessions_spawn`——OpenClaw 原生 ACP thread 绑定，surface 依赖
  3. ACP bridge-as-process——bridge 脚本作为后台进程，surface 无关
- 明确：「用 ACP」意味着「用 ACP bridge」，不是「先试 `sessions_spawn`」

**变更 4 — 更新路由矩阵（移除 CLI fallback 行）**：
- 从路由矩阵中移除"bridge unavailable"行
- 所有场景路由到 bridge（唯一传输层）
- 桌面端/Web 多轮可选 `sessions_spawn` ACP 作为替代

**变更 5 — 添加 ACP bridge 会话生命周期工作流（含 one-shot-via-bridge）**：
- 完整的多轮和 one-shot-via-bridge 工作流
- 移除 one-shot 和 watcher 部分的"emergency fallback"注释

**变更 6 — 更新 session continuity check 决策树**：
- 添加 bridge 路径作为优先检查
- 移除 CLI fallback 相关引用

**变更 7 — 更新 Quick routing table**：
- 移除 CLI fallback 相关条目
- 添加 bridge 相关用户说法映射

**文件**：`references/acp-bridge-protocol.md`

**变更 8 — 移除 CLI 对比表**：
- 移除"Why bridge over CLI non-interactive"对比表（CLI 不再是路径）
- 更新为简要说明 bridge 是唯一传输层

**文件**：`tests/test-bug-condition.sh`

**变更 9 — 添加新检查项**：
- 添加检查：硬性禁令存在
- 添加检查：surface 能力预检存在
- 添加检查：三个 ACP 概念明确区分
- 添加检查：CLI fallback 不存在

**文件**：`tests/test-preservation.sh`

**变更 10 — 移除 CLI 相关保留检查**：
- 移除 CLI 非交互路径保留检查（CLI 被有意移除）
- 保留其他所有保留检查

## 测试策略

### 验证方法

测试策略分两阶段：首先验证 bug condition 确实存在，然后验证修复后满足所有正确性属性且不破坏现有行为。

### 探索性 Bug Condition 检查

**测试用例**：
1. **CLI fallback 不应存在**：检查 SKILL.md → 确认无 EMERGENCY FALLBACK 行
2. **硬性禁令存在**：检查 SKILL.md → 确认包含 PROHIBITED/MUST/禁止 等硬性措辞
3. **Surface 能力预检存在**：检查 SKILL.md → 确认包含 surface capability pre-check 章节
4. **三个 ACP 概念区分**：检查 SKILL.md → 确认包含三概念区分章节
5. **Bridge 为 MANDATORY**：检查 SKILL.md → 确认 bridge 标注为 MANDATORY
6. **one-shot-via-bridge 存在**：检查 SKILL.md → 确认 one-shot-via-bridge 工作流
7. **路由矩阵存在**：检查 SKILL.md → 确认路由矩阵
8. **Bridge 完整工作流存在**：检查 SKILL.md → 确认完整 bridge 生命周期工作流
9. **Session continuity check 包含 bridge**：检查 SKILL.md → 确认 bridge 路径

### Fix Checking

```
FOR ALL input WHERE isBugCondition(input) DO
  result := parseSkillDoc_fixed(input.surface, input.scenario)
  ASSERT result.transport == "bridge-as-process" (MANDATORY)
  ASSERT result.cliNonInteractive == null (removed)
  ASSERT result.hardProhibition("Telegram", "direct ACP spawn").exists()
  ASSERT result.surfacePreCheck.exists()
  ASSERT result.threeACPConcepts.exists()
  ASSERT result.oneShotViaBridge.isDocumented()
  ASSERT result.routingMatrix.coversAll(surfaces, scenarios)
  ASSERT result.sessionContinuityCheck.coversBridge()
END FOR
```

### Preservation Checking

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT sessionsSpawnPath.stillAvailable()  // 桌面端可选替代
  ASSERT sessionContinuityCheck.existingPaths.unchanged()
  ASSERT notificationContract.unchanged()
  ASSERT delegationModes.unchanged()
  // 注意：CLI 非交互被有意移除，不检查其保留
END FOR
```
