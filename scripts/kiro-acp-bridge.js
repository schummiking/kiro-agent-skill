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

let nextId = 1;
let acp = null;
let acpReady = false;
let initializeResult = null;
let pending = new Map();
let currentSessionId = null;
let sessions = {};

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
  });

  acp.stdout.setEncoding('utf8');
  acp.stderr.setEncoding('utf8');

  readline.createInterface({ input: acp.stdout }).on('line', handleAcpLine);
  readline.createInterface({ input: acp.stderr }).on('line', (line) => emit({ type: 'stderr', line }));

  acp.on('exit', (code, signal) => {
    acpReady = false;
    for (const [, p] of pending.entries()) {
      p.reject(new Error(`ACP exited before response (method=${p.method}, code=${code}, signal=${signal})`));
    }
    pending.clear();
    saveState();
    emit({ type: 'exit', code, signal });

    // L3 auto-notification: notify user when ACP process exits
    notifyUser(`ACP process exited (code=${code}, signal=${signal}, session=${currentSessionId || 'none'})`);
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

function stopBridge() {
  emit({ type: 'stop_requested', session: currentSessionId, pid: acp?.pid || null });
  if (acp && !acp.killed) acp.kill('SIGTERM');
}

loadState();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
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
      case 'ping':
        emit({
          type: 'pong',
          pid: acp?.pid || null,
          ready: acpReady,
          session: currentSessionId,
          initializeResult,
          sessions,
        });
        break;
      default:
        emit({ type: 'bridge_error', message: `Unknown op: ${msg.op}` });
    }
  } catch (err) {
    emit({ type: 'bridge_error', op: msg.op, message: String(err?.message || err) });
  }
});
