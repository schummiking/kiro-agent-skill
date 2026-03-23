# Bugfix Requirements Document

## Introduction

ACP bridge (`scripts/kiro-acp-bridge.js`) 在 OpenClaw Telegram surface 第 6 次实测中，bridge 通过 `exec(background:true)` 启动后，OpenClaw 的 process session 在 25ms 内就标记为 `failed`。后续所有 `process submit` 均失败（"No active session found" 或 "write after end"）。

这是本系列第 9 个 bugfix（session-routing → process-stability → control-channel → signal-isolation → sigterm-resilience → session-recovery → sigterm-absorption-scope → bridge-stdio-lifecycle）。

根因：bridge 默认以 stdio 模式启动，控制命令通过 `process.stdin`（readline）接收，事件输出通过 `process.stdout.write()` 发送。当 OpenClaw 用 `exec(background:true)` 启动 bridge 时，stdin 管道几乎立刻 EOF。Bridge 检测到 stdin EOF 后通过 keepalive 和 FIFO fallback 继续运行，但 OpenClaw 侧已经认为 process session 不可写入，标记为 `failed`。后续 `process submit` 全部失败。

关键证据：用户绕过 `process submit`，直接通过 bridge 的 FIFO 控制通道发送命令，manual mode 多轮会话成功跑通。这证明 bridge 本身没问题，问题在于 SKILL.md 和 `references/acp-bridge-protocol.md` 中的启动命令使用了 stdio 模式，而 OpenClaw background process 的 stdin 生命周期不可靠。

修复方向：将 SKILL.md 和 `references/acp-bridge-protocol.md` 中的 bridge 启动命令从 stdio 模式改为 FIFO 模式（`--control fifo`），并将所有 `process action:submit` 指令改为通过 FIFO 写入命令。Bridge 代码本身不修改——FIFO 控制通道功能已在 bugfix #4 (bridge-control-channel) 中实现，完全可用。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 以默认 stdio 模式通过 `exec(background:true)` 启动 THEN OpenClaw 分配的 stdin 管道几乎立刻 EOF，bridge 的 readline 控制通道在第一条命令送达前就已关闭，OpenClaw 侧 process session 在 25ms 内标记为 `failed`

1.2 WHEN OpenClaw process session 已标记为 `failed` 后用户执行 `process action:submit` 发送控制命令 THEN OpenClaw 返回 "No active session found for [sessionId]" 错误，命令无法送达 bridge

1.3 WHEN bridge 检测到 stdin EOF 后自动创建 FIFO fallback 控制通道 THEN OpenClaw 侧不知道 FIFO 路径，也不会通过 FIFO 发送命令——因为 SKILL.md 中的工作流仍然指示使用 `process action:submit`（依赖 stdio）

1.4 WHEN SKILL.md 和 `references/acp-bridge-protocol.md` 中的所有工作流示例均使用 `process action:submit` 作为命令发送方式 THEN 在 OpenClaw background process stdin 不可靠的环境下，整个 bridge 工作流不可用——即使 bridge 本身通过 FIFO 仍然可控

### Expected Behavior (Correct)

2.1 WHEN SKILL.md 和 `references/acp-bridge-protocol.md` 中描述 bridge 启动命令时 THEN 启动命令 SHALL 包含 `--control fifo` 参数，使 bridge 从启动时就使用 FIFO 作为控制通道，不依赖 stdin 的生命周期

2.2 WHEN bridge 以 `--control fifo` 模式启动后 THEN bridge SHALL 在 stdout 输出 `{"type":"control_channel","mode":"fifo","path":"/tmp/kiro-acp-bridge-PID.fifo"}` 事件，agent 通过 `process action:log` 获取 FIFO 路径

2.3 WHEN agent 需要向 bridge 发送控制命令时 THEN SKILL.md 和 `references/acp-bridge-protocol.md` 中的工作流 SHALL 指示通过 FIFO 路径写入 JSONL 命令（如 `echo '{"op":"start",...}' > /tmp/kiro-acp-bridge-PID.fifo`），而不是使用 `process action:submit`

2.4 WHEN agent 需要读取 bridge 输出时 THEN 工作流 SHALL 继续使用 `process action:log`（bridge 的 stdout 输出不受控制通道模式影响）

### Unchanged Behavior (Regression Prevention)

3.1 WHEN bridge 代码（`scripts/kiro-acp-bridge.js`）本身 THEN bridge SHALL CONTINUE TO 不做任何修改——FIFO 控制通道功能已在 bugfix #4 中实现，完全可用

3.2 WHEN bridge 以 `--control fifo` 模式运行时 THEN bridge SHALL CONTINUE TO 正确解析 FIFO 中的 JSONL 命令（start、session_new、send、reply、cancel、stop、ping 等），行为与 stdin 模式完全一致

3.3 WHEN bridge 以 `--control fifo` 模式运行且 FIFO 写入端关闭（EOF） THEN bridge SHALL CONTINUE TO 重新打开 FIFO 等待下一个写入者，控制通道在 bridge 整个生命周期内持续可用

3.4 WHEN bridge 执行 graceful shutdown 时 THEN bridge SHALL CONTINUE TO 清理 FIFO 文件、保存状态、通知用户

3.5 WHEN bridge 收到 SIGTERM/SIGINT 信号时 THEN bridge SHALL CONTINUE TO 执行现有的信号处理逻辑（SIGTERM 吸收、grace period、shutdown），不受控制通道模式切换影响

3.6 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件，保持 keepalive 机制

3.7 WHEN 现有 63 个测试运行时 THEN 所有测试 SHALL CONTINUE TO 通过——测试直接 spawn bridge，不经过 OpenClaw，不受 SKILL.md 文档变更影响

3.8 WHEN bridge 的 stdio 模式（`--control stdio` 或不指定 `--control`） THEN bridge SHALL CONTINUE TO 保持可用——stdio 模式不删除，只是不再作为 SKILL.md 中的默认启动方式
