# Kiro ACP Bridge Protocol (runnable MVP)

## Goal

Provide the smallest useful bridge between OpenClaw and `kiro-cli acp` using stdio + JSON-RPC.

## Why this exists

- `kiro-cli chat` is a terminal interaction surface, not the preferred automation transport.
- ACP is the correct programmatic surface for multi-turn agent control.
- The bridge keeps OpenClaw from dealing with raw ACP details directly.

## Transport facts

ACP uses:
- subprocess launch
- stdin for JSON-RPC requests
- stdout for JSON-RPC responses/notifications
- stderr for logs

Messages are newline-delimited JSON.

## ACP methods used by the bridge

Validated from ACP docs:

- `initialize`
- `session/new`
- `session/load`
- `session/list`
- `session/prompt`
- `session/cancel`
- `session/update` (notification)
- `session/request_permission` (request from agent to client)

## MVP lifecycle

1. Spawn `kiro-cli acp`
2. Send `initialize`
3. Wait for initialize result
4. Send `session/new`
5. Wait for `sessionId`
6. Send `session/prompt`
7. Stream `session/update` notifications
8. Auto-approve ordinary permission requests by responding to `session/request_permission`
9. Surface either:
   - `session_update`
   - `permission_requested`
   - `prompt_completed`
   - `bridge_error`
   - `exit`

## OpenClaw-facing commands

### start
```json
{"op":"start","agent":"kiro_default","model":"claude-opus-4.6","trustAllTools":true}
```

### session_new
```json
{"op":"session_new","cwd":"/absolute/path/project","mode":"semi-auto","mcpServers":[]}
```

### session_load
```json
{"op":"session_load","session":"sess_123","cwd":"/absolute/path/project","mcpServers":[]}
```

### session_list
```json
{"op":"session_list","cwd":"/absolute/path/project"}
```

### send
```json
{"op":"send","session":"sess_123","text":"Install Fetch MCP globally and verify it."}
```

### reply
```json
{"op":"reply","session":"sess_123","text":"继续，优先全局安装"}
```

### cancel
```json
{"op":"cancel","session":"sess_123"}
```

### stop
```json
{"op":"stop"}
```

### ping
```json
{"op":"ping"}
```

## Bridge-emitted events

### process_started
```json
{"type":"process_started","pid":12345,"args":["acp","--agent","kiro_default"]}
```

### ready
```json
{"type":"ready","result":{"protocolVersion":1,"agentCapabilities":{}}}
```

### session_started
```json
{"type":"session_started","session":"sess_123","result":{"sessionId":"sess_123"}}
```

### session_loaded
```json
{"type":"session_loaded","session":"sess_123","result":null}
```

### session_list
```json
{"type":"session_list","result":{"sessions":[...]}}
```

### session_update
```json
{"type":"session_update","session":"sess_123","update":{...},"text":"Checking current MCP config..."}
```

### permission_requested
```json
{"type":"permission_requested","session":"sess_123","request":{...}}
```

### permission_auto_response
```json
{"type":"permission_auto_response","session":"sess_123","selected":{"optionId":"allow-once","kind":"allow_once","name":"Allow once"}}
```

### prompt_completed
```json
{"type":"prompt_completed","session":"sess_123","result":{"stopReason":"end_turn"}}
```

### stderr
```json
{"type":"stderr","line":"verbose log line"}
```

### exit
```json
{"type":"exit","code":0,"signal":null}
```

### bridge_error
```json
{"type":"bridge_error","op":"send","message":"No session id"}
```

## State file

The bridge writes a tiny local state file:

```text
skills/kiro-agent/scripts/kiro-acp-state.json
```

It stores:
- current ACP process pid
- readiness state
- current session id
- known sessions and cwd bindings

## Auto-permission behavior in MVP

The bridge auto-selects the first safe allow option it sees:
1. `allow_always`
2. `allow_once`
3. otherwise `cancelled`

This is good enough for first integration. More refined policy mapping can be added later.

## Auto-notification behavior

The bridge automatically notifies the user via `openclaw system event --mode now` at two points:

1. **On `prompt_completed`**: fires after each prompt finishes, with session ID and stop reason.
2. **On ACP process exit**: fires when the `kiro-cli acp` subprocess exits for any reason (normal exit, crash, signal).

This provides L2+L3 notification guarantees for the ACP path without requiring the calling agent to poll or remember to notify. If `openclaw` is not in PATH, the notification silently fails and a `notify_error` event is emitted on the bridge's stdout.

### Bridge-emitted notification events

```json
{"type":"notify_error","message":"Failed to notify: ..."}
```

This event appears only when the `openclaw system event` call fails. Under normal operation, notifications are fire-and-forget with no bridge-side event.

## First live test plan

1. Start bridge
2. Start ACP
3. Create session with absolute cwd
4. Send a tiny prompt like `Say READY and do nothing else.`
5. Confirm:
   - `ready`
   - `session_started`
   - at least one `session_update`
   - `prompt_completed`

If that works, the bridge is ready for real Kiro skill integration.
