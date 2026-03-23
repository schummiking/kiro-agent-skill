# Bugfix Requirements Document

## Introduction

ACP bridge 进程 (`scripts/kiro-acp-bridge.js`) 作为 OpenClaw 与 Kiro 之间的唯一传输层，无法稳定保持后台运行。主要表现为：bridge 以 `exec(background:true)` 启动后，因 stdin EOF 导致 readline close、Node.js 事件循环无活跃 handle 而立即退出；即使成功运行，也会因缺少信号处理而被 SIGTERM 直接杀死，无法优雅关闭 ACP 子进程或保存状态。该问题导致用户无法通过 OpenClaw 的 Kiro Agent skill 可靠地使用 bridge 进行任务委派。

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN bridge 以后台进程方式启动（`exec(background:true)`）且 stdin pipe 被关闭或收到 EOF THEN `readline.createInterface({ input: process.stdin })` 的 `rl` 实例触发 `close` 事件，Node.js 事件循环中无其他活跃 handle，进程立即自动退出

1.2 WHEN bridge 进程收到 SIGTERM 信号（宿主侧进程管理回收） THEN 进程直接终止，不会先关闭 ACP 子进程、不会保存当前状态、不会通知用户，导致 ACP 子进程成为孤儿进程

1.3 WHEN bridge 进程收到 SIGINT 信号 THEN 进程直接终止，同样无任何 graceful shutdown 逻辑

1.4 WHEN bridge 进程在后台长时间运行且无 stdin 输入 THEN 宿主侧无法判断 bridge 是否仍然存活（无心跳/keepalive 机制），可能误判为 idle 并回收进程

### Expected Behavior (Correct)

2.1 WHEN bridge 以后台进程方式启动且 stdin pipe 被关闭或收到 EOF THEN bridge 进程 SHALL 保持运行（通过 keepalive 机制维持事件循环活跃），继续监听后续可能重新建立的输入通道或等待显式 stop 命令

2.2 WHEN bridge 进程收到 SIGTERM 信号 THEN bridge 进程 SHALL 执行 graceful shutdown：先向 ACP 子进程发送终止信号并等待其退出、保存当前状态到 state 文件、发送 `exit` 事件到 stdout、通知用户，然后再退出

2.3 WHEN bridge 进程收到 SIGINT 信号 THEN bridge 进程 SHALL 执行与 SIGTERM 相同的 graceful shutdown 流程

2.4 WHEN bridge 进程在后台运行时 THEN bridge 进程 SHALL 定期输出心跳事件（如 `{"type":"heartbeat","pid":...,"uptime":...,"session":...}`），使宿主侧能判断 bridge 仍然存活

### Unchanged Behavior (Regression Prevention)

3.1 WHEN 用户通过 stdin 发送有效的 JSONL 命令（start、session_new、send 等） THEN bridge SHALL CONTINUE TO 正确解析并执行对应的 ACP 操作，返回正确的事件响应

3.2 WHEN ACP 子进程正常退出 THEN bridge SHALL CONTINUE TO 发送 `exit` 事件、清理 pending promises、保存状态、并通过 `openclaw system event` 通知用户

3.3 WHEN 用户发送 `{"op":"stop"}` 命令 THEN bridge SHALL CONTINUE TO 向 ACP 子进程发送 SIGTERM 并正常关闭

3.4 WHEN 用户发送 `{"op":"ping"}` 命令 THEN bridge SHALL CONTINUE TO 返回包含 pid、ready 状态、session 信息的 pong 响应

3.5 WHEN ACP 子进程发送 `session/request_permission` 请求 THEN bridge SHALL CONTINUE TO 自动选择 allow_always > allow_once > cancelled 策略并响应

3.6 WHEN ACP 子进程发送 `session/update` 通知 THEN bridge SHALL CONTINUE TO 正确提取文本内容并转发为 `session_update` 事件
