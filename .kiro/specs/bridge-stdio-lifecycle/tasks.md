# 实施计划

- [x] 1. 编写 bug condition 探索性测试
  - **Property 1: Bug Condition** — 文档使用 stdio 模式且依赖 process action:submit
  - **重要**: 在修复文档之前编写并运行此测试
  - **目标**: 确认 SKILL.md 和 acp-bridge-protocol.md 中确实存在 bug condition
  - **Scoped PBT 方法**: 扫描两个文档文件的内容，验证以下条件成立：
    - SKILL.md 中的 bridge 启动命令不包含 `--control fifo`
    - SKILL.md 中使用 `process action:submit` 发送控制命令（非仅用于 `process action:log`）
    - `references/acp-bridge-protocol.md` 中的启动命令不包含 `--control fifo`
    - `references/acp-bridge-protocol.md` 中使用 `process action:submit` 发送控制命令
  - 测试读取文件内容，用正则/字符串匹配检查模式
  - 在未修复文档上运行 — 预期 **失败**（确认 bug condition 存在）
  - 记录发现的反例（哪些行包含 `process action:submit`，哪些启动命令缺少 `--control fifo`）
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. 编写 preservation 属性测试（在修复文档之前）
  - **Property 2: Preservation** — Bridge 代码和测试文件不变
  - **重要**: 遵循观察优先方法论
  - 观察: 计算 `scripts/kiro-acp-bridge.js` 的 SHA256 校验和
  - 观察: 计算 `tests/` 目录下所有测试文件的 SHA256 校验和
  - 编写属性测试: 修复后上述校验和 SHALL 与修复前完全一致
  - 运行现有 12 个测试套件（63 个测试），确认全部通过作为基线
  - 在未修复代码上验证测试通过
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

- [x] 3. 修复文档 — 将 bridge 工作流从 stdio 模式改为 FIFO 模式

  - [x] 3.1 更新 SKILL.md
    - 启动命令加 `--control fifo` 参数
    - 新增步骤: 通过 `process action:log` 读取 `control_channel` 事件获取 FIFO 路径
    - 所有 `process action:submit` 发送控制命令改为 `echo '...' > FIFO_PATH`
    - 保留 `process action:log` 用于读取 bridge 输出
    - Step 2a session continuity check 中的 bridge 交互方式同步更新
    - _Bug_Condition: isBugCondition(doc) where hasStdioLaunch AND hasProcessSubmit_
    - _Expected_Behavior: 启动命令包含 --control fifo，命令发送通过 FIFO 写入_
    - _Preservation: Bridge 代码不变，process action:log 继续用于读取输出_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 更新 references/acp-bridge-protocol.md
    - "OpenClaw integration workflow" 多轮工作流示例: 启动命令加 `--control fifo`，新增获取 FIFO 路径步骤，`process action:submit` 改为 FIFO 写入
    - "One-shot-via-bridge" 示例同步更新
    - 保留 `process action:log` 用于读取输出
    - _Bug_Condition: isBugCondition(doc) where hasStdioLaunch AND hasProcessSubmit_
    - _Expected_Behavior: 启动命令包含 --control fifo，命令发送通过 FIFO 写入_
    - _Preservation: Bridge 代码不变，process action:log 继续用于读取输出_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.3 验证 bug condition 探索性测试现在通过
    - **Property 1: Expected Behavior** — 文档使用 FIFO 模式
    - **重要**: 重新运行任务 1 中的同一测试 — 不要编写新测试
    - 运行 bug condition 测试，预期 **通过**（确认文档已修复）
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.4 验证 preservation 测试仍然通过
    - **Property 2: Preservation** — Bridge 代码和测试文件不变
    - **重要**: 重新运行任务 2 中的同一测试 — 不要编写新测试
    - 重新计算校验和，确认与修复前一致
    - 运行现有 12 个测试套件，确认 63 个测试全部通过
    - _Requirements: 3.1, 3.2, 3.7_

  - [x] 3.5 运行全部 12 个现有测试套件
    - 运行 `tests/` 目录下所有测试文件，确认 63 个测试全部通过
    - 确认无回归
    - _Requirements: 3.7_

- [x] 4. 检查点 — 确认所有测试通过
  - 确认所有测试通过，如有问题询问用户。
