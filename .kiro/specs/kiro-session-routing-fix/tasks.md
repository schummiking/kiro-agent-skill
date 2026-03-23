# 实施计划

- [x] 1. 编写 Bug Condition 探索性测试
  - **Property 1: Bug Condition** — 传输路由缺少统一 Bridge 传输层 + 约束不够硬 + 三概念未区分
  - 检查当前 SKILL.md：确认 CLI fallback 不存在（EMERGENCY FALLBACK 行已移除）
  - 检查当前 SKILL.md：确认包含硬性禁令（PROHIBITED/MUST/禁止）
  - 检查当前 SKILL.md：确认包含 surface 能力预检章节
  - 检查当前 SKILL.md：确认三个 ACP 概念明确区分
  - 检查当前 SKILL.md：确认 bridge 标注为 MANDATORY
  - 检查当前 SKILL.md：确认 one-shot-via-bridge 工作流存在
  - 检查当前 SKILL.md：确认路由矩阵存在
  - 检查当前 SKILL.md：确认完整 bridge 生命周期工作流
  - 检查当前 SKILL.md：确认 session continuity check 包含 bridge 路径
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 2. 编写 Preservation 属性测试（在实施修复之前）
  - **Property 2: Preservation** — 现有路径和行为可用性不变（CLI 被有意移除，不检查）
  - 编写属性测试：验证 `sessions_spawn` ACP 路径仍然存在
  - 编写属性测试：验证 session continuity check 的前两条路径未被删除
  - 编写属性测试：验证 `references/delegation-modes.md` 和 `references/notification-contract.md` 未被修改
  - 注意：CLI 非交互路径被有意移除，不再检查其保留
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. 修复 Kiro Session Routing — 统一 Bridge 传输架构 + 硬性禁令 + 三概念区分

  - [x] 3.1 变更 1 — 移除 CLI fallback，Bridge 为唯一传输层（MANDATORY）
    - 从 SKILL.md transport routing 表中完全移除 EMERGENCY FALLBACK 行
    - Bridge 标注为 MANDATORY（唯一传输层）
    - `sessions_spawn` ACP 标注为桌面端/Web 的可选替代
    - _Requirements: 2.1_

  - [x] 3.2 变更 2 — 升级约束为硬性禁令 + Surface 能力预检
    - 添加硬性禁令：Telegram 上禁止 direct ACP thread spawn
    - 添加 Surface Capability Pre-check 作为强制性第一步
    - 将措辞从推荐性升级为强制性（MANDATORY/PROHIBITED）
    - _Requirements: 2.2, 2.3_

  - [x] 3.3 变更 3 — 明确区分三个 ACP 概念
    - 添加"三个 ACP 概念"章节
    - 明确：「用 ACP」意味着「用 ACP bridge」
    - _Requirements: 2.4_

  - [x] 3.4 变更 4 — 更新路由矩阵（移除 CLI fallback 行）
    - 从路由矩阵中移除"bridge unavailable"行
    - 所有场景路由到 bridge
    - _Requirements: 2.6_

  - [x] 3.5 变更 5 — 添加/更新 ACP bridge 会话生命周期工作流
    - 完整的多轮和 one-shot-via-bridge 工作流
    - 移除 CLI fallback 相关的 one-shot 和 watcher 部分
    - _Requirements: 2.5, 2.7_

  - [x] 3.6 变更 6 — 更新 session continuity check 决策树
    - 添加 bridge 路径作为优先检查
    - 移除 CLI fallback 相关引用
    - _Requirements: 2.8_

  - [x] 3.7 变更 7 — 更新 Quick routing table
    - 移除 CLI fallback 相关条目
    - 添加 bridge 相关用户说法映射
    - _Requirements: 2.1, 2.6_

  - [x] 3.8 变更 8 — 更新 references/acp-bridge-protocol.md
    - 移除 CLI 对比表（bridge vs CLI）
    - 更新为说明 bridge 是唯一传输层
    - _Requirements: 2.1_

  - [x] 3.9 变更 9 — 更新 test-bug-condition.sh
    - 添加检查：硬性禁令、surface 预检、三概念区分、CLI fallback 不存在
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 3.10 变更 10 — 更新 test-preservation.sh
    - 移除 CLI 非交互路径保留检查
    - 保留其他所有保留检查
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 3.11 验证 Bug Condition 测试通过
    - 运行 test-bug-condition.sh — 预期通过
    - _Requirements: 2.1-2.8_

  - [x] 3.12 验证 Preservation 测试通过
    - 运行 test-preservation.sh — 预期通过
    - _Requirements: 3.1-3.4_

- [x] 4. 检查点 — 确保所有测试通过
  - 验证 Bug Condition 测试通过
  - 验证 Preservation 测试通过
  - 确认所有变更已正确实施
