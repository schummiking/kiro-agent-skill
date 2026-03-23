#!/usr/bin/env node

/**
 * Kiro ACP Bridge (lightweight runnable MVP)
 *
 * Goal:
 * - Spawn `kiro-cli acp`
 * - Speak ACP over newline-delimited JSON-RPC on stdin/stdout
 * - Expose a tiny JSONL control interface for OpenClaw / shell automation
 *
 * Notes:
 * - Uses ACP method names validated from ACP docs: initialize, session/new,
 *   session/load, session/prompt, session/cancel, session/list, session/update,
 *   session/request_permission.
 * - Keeps the implementation intentionally small.
 */

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');

const STATE_PATH = path.join(__dirname, 'kiro-acp-state.json');

const { execFile } = require('node:child_process');

/**
 * Fire-and-forget notification to user via openclaw system event.
 * This is the L2/L3 notification layer for the ACP path.
 */
function notifyUser(text) {
  execFile('openclaw', ['system', 'event', '--text', `Kiro: ${text}`, '--mode', 'now'], (err) => {
    if (err) emit({ type: 'notify_error', message: `Failed to notify: ${err.message}` });
  });
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const startTime = Date.now();

let nextId = 1;
let acp = null;
let acpReady = false;
let initializeResult = null;
let pending = new Map();
let currentSessionId = null;
let sessions = {};
let shuttingDown = false;
let bridgeInitiatedKill = false;
let sigTermCount = 0;
let firstSigTermTime = null;
let sigTermTimeoutTimer = null;
let heartbeatTimer;

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

const { controlMode, controlPath } = parseArgs(process.argv);

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    sessions = data.sessions || {};
    currentSessionId = data.currentSessionId || null;
  } catch {
    sessions = {};
    currentSessionId = null;
  }
}

function saveState() {
  const data = {
    pid: acp?.pid || null,
    ready: acpReady,
    currentSessionId,
    sessions,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function rpc(method, params = {}) {
  if (!acp || acp.killed) throw new Error('ACP process is not running');
  const id = nextId++;
  const payload = { jsonrpc: '2.0', id, method, params };
  acp.stdin.write(JSON.stringify(payload) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method, ts: Date.now(), params });
  });
}

function normalizeTextFromUpdate(update) {
  const u = update || {};
  const content = u.content;
  if (content?.type === 'text' && typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item?.type === 'content' && item.content?.type === 'text') return item.content.text;
        if (item?.content?.type === 'text') return item.content.text;
        return null;
      })
      .filter(Boolean)
      .join('\n');
  }
  return null;
}

async function autoHandlePermission(msg) {
  const reqId = msg.id;
  const params = msg.params || {};
  const options = params.options || [];
  const allowAlways = options.find((o) => o.kind === 'allow_always');
  const allowOnce = options.find((o) => o.kind === 'allow_once');
  const selected = allowAlways || allowOnce || null;

  const response = {
    jsonrpc: '2.0',
    id: reqId,
    result: {
      outcome: selected
        ? { outcome: 'selected', optionId: selected.optionId }
        : { outcome: 'cancelled' },
    },
  };

  acp.stdin.write(JSON.stringify(response) + '\n');
  emit({
    type: 'permission_auto_response',
    session: params.sessionId || null,
    selected: selected ? { optionId: selected.optionId, kind: selected.kind, name: selected.name } : null,
  });
}

function handleAcpLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emit({ type: 'acp_non_json', line });
    return;
  }

  if (typeof msg.id !== 'undefined' && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
    return;
  }

  if (msg.method === 'session/update') {
    const sessionId = msg.params?.sessionId || currentSessionId || null;
    const update = msg.params?.update ?? {};
    const text = normalizeTextFromUpdate(update);
    emit({ type: 'session_update', session: sessionId, update, text });
    return;
  }

  if (msg.method === 'session/request_permission') {
    emit({ type: 'permission_requested', session: msg.params?.sessionId || null, request: msg.params || {} });
    autoHandlePermission(msg).catch((err) => {
      emit({ type: 'bridge_error', message: `Failed to auto-handle permission: ${String(err?.message || err)}` });
    });
    return;
  }

  emit({ type: 'acp_notification', message: msg });
}

async function startAcp({ agent, model, trustAllTools = true, verbose = 0 } = {}) {
  if (acp && !acp.killed) {
    emit({ type: 'info', message: 'ACP process already running', pid: acp.pid });
    return;
  }

  const args = ['acp'];
  if (agent) args.push('--agent', agent);
  if (model) args.push('--model', model);
  if (trustAllTools) args.push('--trust-all-tools');
  for (let i = 0; i < verbose; i++) args.push('--verbose');

  acp = spawn('kiro-cli', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    cwd: process.cwd(),
    detached: true,
  });

  acp.stdout.setEncoding('utf8');
  acp.stderr.setEncoding('utf8');

  readline.createInterface({ input: acp.stdout }).on('line', handleAcpLine);
  readline.createInterface({ input: acp.stderr }).on('line', (line) => emit({ type: 'stderr', line }));

  acp.on('exit', (code, signal) => {
    acpReady = false;
    const terminatedBy = bridgeInitiatedKill ? 'bridge'
      : signal ? 'external'
      : 'self';
    for (const [, p] of pending.entries()) {
      p.reject(new Error(`ACP exited before response (method=${p.method}, code=${code}, signal=${signal})`));
    }
    pending.clear();
    saveState();
    emit({ type: 'exit', code, signal, terminatedBy });

    // L3 auto-notification: notify user when ACP process exits
    notifyUser(`ACP process exited (code=${code}, signal=${signal}, terminatedBy=${terminatedBy}, session=${currentSessionId || 'none'})`);
  });

  acp.on('error', (err) => emit({ type: 'error', message: err.message }));

  emit({ type: 'process_started', pid: acp.pid, args });

  const result = await rpc('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'openclaw-kiro-bridge', title: 'OpenClaw Kiro Bridge', version: '0.2.0' },
  });

  initializeResult = result;
  acpReady = true;
  saveState();
  emit({ type: 'ready', result });
}

async function createSession({ cwd, mode, mcpServers = [] } = {}) {
  if (!acpReady) throw new Error('ACP is not ready');
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('session_new requires absolute cwd');

  const result = await rpc('session/new', { cwd, mcpServers });
  currentSessionId = result?.sessionId || null;
  sessions[currentSessionId] = {
    cwd,
    mode: mode || null,
    createdAt: new Date().toISOString(),
    mcpServers,
  };
  saveState();
  emit({ type: 'session_started', session: currentSessionId, result });
}

async function loadSession({ session, cwd, mcpServers = [] } = {}) {
  if (!acpReady) throw new Error('ACP is not ready');
  if (!session) throw new Error('session/load requires session id');
  if (!cwd || !path.isAbsolute(cwd)) throw new Error('session/load requires absolute cwd');

  const result = await rpc('session/load', { sessionId: session, cwd, mcpServers });
  currentSessionId = session;
  sessions[session] = sessions[session] || { cwd, mcpServers, loadedAt: new Date().toISOString() };
  saveState();
  emit({ type: 'session_loaded', session, result });
}

async function listSessions({ cwd, cursor } = {}) {
  if (!acpReady) throw new Error('ACP is not ready');
  const result = await rpc('session/list', { cwd, cursor });
  emit({ type: 'session_list', result });
}

async function sendPrompt({ session, text } = {}) {
  if (!acpReady) throw new Error('ACP is not ready');
  const sessionId = session || currentSessionId;
  if (!sessionId) throw new Error('No session id');
  if (!text) throw new Error('No prompt text');

  const result = await rpc('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text,
      },
    ],
  });
  emit({ type: 'prompt_completed', session: sessionId, result });

  // L2 auto-notification: notify user via openclaw system event on prompt completion
  const stopReason = result?.stopReason || 'unknown';
  const summary = `ACP prompt completed (session: ${sessionId}, stop: ${stopReason})`;
  notifyUser(summary);
}

async function cancelSession({ session } = {}) {
  if (!acpReady) throw new Error('ACP is not ready');
  const sessionId = session || currentSessionId;
  if (!sessionId) throw new Error('No session id');
  acp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }) + '\n');
  emit({ type: 'cancel_sent', session: sessionId });
}

async function gracefulShutdown(reason) {
  if (shuttingDown) return;

  // SIGTERM absorption: if active session, no pending RPCs, first SIGTERM → absorb
  if (reason === 'SIGTERM' && acpReady && currentSessionId && pending.size === 0 && sigTermCount === 0) {
    sigTermCount++;
    firstSigTermTime = Date.now();
    emit({
      type: 'bridge_signal_received',
      signal: reason,
      pendingCalls: pending.size,
      timestamp: new Date().toISOString(),
      deferred: true,
    });
    // Auto-shutdown after 60s if no second SIGTERM
    sigTermTimeoutTimer = setTimeout(() => {
      emit({ type: 'info', message: 'SIGTERM absorption timeout (60s), executing shutdown' });
      sigTermCount++;
      gracefulShutdown('SIGTERM_TIMEOUT');
    }, 60_000);
    return; // absorbed, do not shutdown
  }

  shuttingDown = true;
  if (sigTermTimeoutTimer) { clearTimeout(sigTermTimeoutTimer); sigTermTimeoutTimer = null; }

  clearInterval(heartbeatTimer);

  // Signal observability event — emitted before shutdown event
  emit({
    type: 'bridge_signal_received',
    signal: reason,
    pendingCalls: pending.size,
    timestamp: new Date().toISOString(),
    deferred: false,
  });

  // Grace period: wait for pending RPCs to complete (up to 30s)
  if (pending.size > 0) {
    const GRACE_TIMEOUT_MS = 30_000;
    await Promise.race([
      new Promise((resolve) => {
        const check = setInterval(() => {
          if (pending.size === 0) { clearInterval(check); resolve(); }
        }, 1000);
      }),
      new Promise((resolve) => setTimeout(() => {
        emit({ type: 'info', message: `Grace period timeout (${GRACE_TIMEOUT_MS}ms), forcing shutdown` });
        resolve();
      }, GRACE_TIMEOUT_MS)),
    ]);
  }

  if (controlMode === 'fifo' && controlPath) {
    try { fs.unlinkSync(controlPath); } catch {}
  }

  emit({ type: 'shutdown', reason, session: currentSessionId, pid: acp?.pid || null });

  bridgeInitiatedKill = true;

  if (acp && !acp.killed) {
    acp.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => acp.on('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (!acp.killed) acp.kill('SIGKILL');
  }

  saveState();
  notifyUser(`Bridge shutdown: ${reason} (session=${currentSessionId || 'none'})`);
  process.exit(0);
}

function stopBridge() {
  clearInterval(heartbeatTimer);
  emit({ type: 'stop_requested', session: currentSessionId, pid: acp?.pid || null });
  bridgeInitiatedKill = true;
  if (acp && !acp.killed) acp.kill('SIGTERM');
}

heartbeatTimer = setInterval(() => {
  emit({
    type: 'heartbeat',
    pid: process.pid,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    session: currentSessionId,
    ready: acpReady,
  });
}, HEARTBEAT_INTERVAL_MS);

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
      case 'start':
        await startAcp(msg);
        break;
      case 'session_new':
        await createSession(msg);
        break;
      case 'session_load':
        await loadSession(msg);
        break;
      case 'session_list':
        await listSessions(msg);
        break;
      case 'send':
      case 'reply':
        await sendPrompt({ session: msg.session, text: msg.text });
        break;
      case 'cancel':
        await cancelSession(msg);
        break;
      case 'stop':
        stopBridge();
        break;
      case 'ping': {
        const pong = {
          type: 'pong',
          pid: acp?.pid || null,
          ready: acpReady,
          session: currentSessionId,
          initializeResult,
          sessions,
        };
        if (controlMode === 'fifo') {
          pong.controlMode = controlMode;
          pong.controlPath = controlPath;
        }
        emit(pong);
        break;
      }
      default:
        emit({ type: 'bridge_error', message: `Unknown op: ${msg.op}` });
    }
  } catch (err) {
    emit({ type: 'bridge_error', op: msg.op, message: String(err?.message || err) });
  }
}

function setupFifoControl(fifoPath) {
  require('node:child_process').execFileSync('mkfifo', [fifoPath]);

  function openFifoReader() {
    const stream = fs.createReadStream(fifoPath, { encoding: 'utf8' });
    const fifoRl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    fifoRl.on('line', (line) => processCommand(line));

    fifoRl.on('close', () => {
      stream.destroy();
      emit({ type: 'info', message: 'FIFO EOF, reopening for next writer' });
      setImmediate(() => openFifoReader());
    });

    stream.on('error', (err) => {
      emit({ type: 'bridge_error', message: `FIFO read error: ${err.message}` });
    });
  }

  openFifoReader();
}

loadState();

if (controlMode === 'fifo') {
  setupFifoControl(controlPath);
  emit({ type: 'control_channel', mode: 'fifo', path: controlPath });
} else {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => processCommand(line));
  emit({ type: 'control_channel', mode: 'stdio' });
  rl.on('close', () => {
    emit({ type: 'info', message: 'stdin closed (EOF), bridge remains running via keepalive' });
    // Auto-fallback: create FIFO control channel so bridge remains controllable
    const fallbackPath = `/tmp/kiro-acp-bridge-${process.pid}.fifo`;
    try {
      setupFifoControl(fallbackPath);
      emit({ type: 'control_channel', mode: 'fifo', path: fallbackPath });
      // Self-diagnostic ping to prove bridge is still controllable
      processCommand(JSON.stringify({ op: 'ping' }));
    } catch (err) {
      emit({ type: 'bridge_error', message: `FIFO fallback failed: ${err.message}` });
    }
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
