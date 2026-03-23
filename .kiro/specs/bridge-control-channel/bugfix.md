# Bugfix Requirements Document

## Introduction

`kiro-acp-bridge.js` 通过 OpenClaw `exec(background:true)` 启动后，stdin 控制通道不可靠，导致两种故障模式：(A) 控制通道提前关闭（`write after end`），(B) ACP 子进程在 prompt 执行中被 SIGTERM 终止。根因是 bridge 设计假设 stdin 是持久控制通道，但 OpenClaw 的 background exec 不保证 stdin 持久可写——这是控制通道契约不匹配。

上一个 bugfix（bridge-process-stability）已解决 stdin EOF 后进程退出的问题（添加了 keepalive timer），但只解决了"进程不退出"，没解决"控制通道断了后命令发不进去"。FIFO workaround 已验证成功：用 named pipe 替代 stdin 作为控制通道，bridge 完成了完整的 start → session_new → send → prompt_completed 流程，证明问题在 stdin 可靠性而非 bridge 逻辑或 ACP 协议。

本 bugfix 需要 bridge 原生支持 FIFO 作为替代控制通道（`--control fifo` 模式），使 bridge 在 Telegram/受限 surface 上可靠运行。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 以 `exec(background:true)` 启动且 OpenClaw 未保持 stdin pipe 打开 THEN 后续通过 `process submit/write` 发送的 JSONL 命令报 `write after end` 错误，第一条命令都无法送达 bridge

1.2 WHEN bridge 通过 stdin 控制通道成功启动并进入 prompt 执行阶段，但宿主侧因 stdin 断开/PTY 生命周期/idle 检测回收进程 THEN ACP 子进程在 prompt 执行中被 SIGTERM 终止，日志显示 `{"type":"shutdown","reason":"SIGTERM"}` + `ACP exited before response (method=session/prompt, code=null, signal=SIGTERM)`

1.3 WHEN bridge 仅支持 stdin 作为控制通道且 stdin 已断开 THEN 即使 bridge 进程仍存活（keepalive timer 生效），也无法接收任何新的控制命令，bridge 成为不可控的僵尸状态

1.4 WHEN 用户需要在 Telegram/受限 surface 上进行多轮 manual mode 会话 THEN 没有可靠的控制通道方案，只能手动创建 FIFO 并用 shell 重定向作为临时 workaround

### Expected Behavior (Correct)

2.1 WHEN bridge 以 `--control fifo` 模式启动 THEN bridge SHALL 创建一个 named pipe（FIFO）文件作为控制通道，从该 FIFO 持续读取 JSONL 命令，不依赖 stdin 的生命周期

2.2 WHEN bridge 以 `--control fifo` 模式运行且外部进程向 FIFO 写入 JSONL 命令 THEN bridge SHALL 正确解析并执行对应的 ACP 操作（start、session_new、send 等），行为与 stdin 模式完全一致

2.3 WHEN bridge 以 `--control fifo` 模式启动 THEN bridge SHALL 在 stdout 输出 `{"type":"control_channel","mode":"fifo","path":"/path/to/fifo"}` 事件，告知调用方 FIFO 路径

2.4 WHEN bridge 以 `--control fifo` 模式运行且 FIFO 的写入端关闭（EOF） THEN bridge SHALL 重新打开 FIFO 等待下一个写入者，而不是终止控制通道读取——FIFO 控制通道应在 bridge 整个生命周期内持续可用

2.5 WHEN bridge 未指定 `--control` 参数或指定 `--control stdio` THEN bridge SHALL 保持当前 stdin 控制通道行为不变（向后兼容）

2.6 WHEN bridge 以 `--control fifo` 模式关闭（graceful shutdown） THEN bridge SHALL 清理（删除）创建的 FIFO 文件

2.7 WHEN bridge 以 `--control fifo` 模式启动且指定了 `--control-path <path>` THEN bridge SHALL 使用指定路径创建 FIFO，而非默认路径

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户通过 stdin 发送有效的 JSONL 命令（start、session_new、send、reply、cancel、stop、ping） THEN bridge SHALL CONTINUE TO 正确解析并执行对应的 ACP 操作，返回正确的事件响应

3.2 WHEN ACP 子进程正常退出或异常退出 THEN bridge SHALL CONTINUE TO 发送 `exit` 事件、清理 pending promises、保存状态、并通过 `openclaw system event` 通知用户

3.3 WHEN bridge 进程收到 SIGTERM/SIGINT 信号 THEN bridge SHALL CONTINUE TO 执行 graceful shutdown 流程（关闭 ACP 子进程、保存状态、通知用户）

3.4 WHEN ACP 子进程发送 `session/update` 通知或 `session/request_permission` 请求 THEN bridge SHALL CONTINUE TO 正确处理并转发事件

3.5 WHEN bridge 在后台运行时 THEN bridge SHALL CONTINUE TO 定期输出心跳事件

3.6 WHEN 用户发送 `{"op":"ping"}` 命令 THEN bridge SHALL CONTINUE TO 返回包含 pid、ready 状态、session 信息的 pong 响应，且在 FIFO 模式下额外包含 `controlMode` 和 `controlPath` 字段
