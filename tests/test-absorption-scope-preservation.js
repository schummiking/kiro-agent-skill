#!/usr/bin/env node

/**
 * SIGTERM Absorption Scope — Preservation Property Tests
 *
 * Verifies that existing bridge behaviors are UNCHANGED before and after the fix.
 * All tests MUST PASS on both unfixed and fixed code.
 *
 * Tests:
 * 1. No-session SIGTERM immediate shutdown
 * 2. SIGINT immediate shutdown
 * 3. op:stop immediate termination
 * 4. ping/pong response format
 * 5. unknown op error
 * 6. invalid JSON error
 * 7. bridge_signal_received event fields
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 5000;

const results = [];

function log(msg) {
  console.log(`[absorption-scope-pres] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

function sendAndReceive(inputLine, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'control_channel' || obj.type === 'heartbeat' || obj.type === 'bridge_signal_received') continue;
          if (!resolved) { resolved = true; child.kill('SIGKILL'); resolve({ response: obj }); }
          return;
        } catch { /* not json yet */ }
      }
    });

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'control_channel' || obj.type === 'heartbeat' || obj.type === 'bridge_signal_received') continue;
            resolve({ response: obj }); return;
          } catch { /* ignore */ }
        }
        resolve({ response: null });
      }
    });

    const timer = setTimeout(() => { if (!resolved) { resolved = true; child.kill('SIGKILL'); resolve({ response: null }); } }, timeoutMs);
    child.on('exit', () => clearTimeout(timer));
    if (inputLine !== null) child.stdin.write(inputLine + '\n');
  });
}

function spawnAndSignal(signal, delayMs = 500, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    setTimeout(() => child.kill(signal), delayMs);

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve(stdout.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
    });

    const timer = setTimeout(() => { if (!resolved) { resolved = true; child.kill('SIGKILL'); resolve([]); } }, timeoutMs);
    child.on('exit', () => clearTimeout(timer));
  });
}

async function testNoSessionSigterm() {
  log('--- Test 1: no-session SIGTERM immediate shutdown ---');
  const events = await spawnAndSignal('SIGTERM');
  const shutdown = events.find(e => e.type === 'shutdown');
  if (shutdown && shutdown.reason === 'SIGTERM') {
    record('no-session SIGTERM', true, 'Immediate shutdown with reason=SIGTERM');
  } else {
    record('no-session SIGTERM', false, `No shutdown event. Events: ${JSON.stringify(events.map(e => e.type))}`);
  }
}

async function testSigintShutdown() {
  log('--- Test 2: SIGINT immediate shutdown ---');
  const events = await spawnAndSignal('SIGINT');
  const shutdown = events.find(e => e.type === 'shutdown');
  if (shutdown && shutdown.reason === 'SIGINT') {
    record('SIGINT shutdown', true, 'Immediate shutdown with reason=SIGINT');
  } else {
    record('SIGINT shutdown', false, `No shutdown event. Events: ${JSON.stringify(events.map(e => e.type))}`);
  }
}

async function testOpStop() {
  log('--- Test 3: op:stop immediate termination ---');
  const { response } = await sendAndReceive('{"op":"stop"}');
  if (response && response.type === 'stop_requested') {
    record('op:stop', true, `type=stop_requested, session=${response.session}`);
  } else {
    record('op:stop', false, `Unexpected response: ${JSON.stringify(response)}`);
  }
}

async function testPingPong() {
  log('--- Test 4: ping/pong response format ---');
  const { response } = await sendAndReceive('{"op":"ping"}');
  if (!response) { record('ping/pong', false, 'No response'); return; }
  const checks = [];
  if (response.type !== 'pong') checks.push(`type="${response.type}"`);
  if (typeof response.pid !== 'number' && response.pid !== null) checks.push(`pid=${response.pid}`);
  if (typeof response.ready !== 'boolean') checks.push(`ready=${response.ready}`);
  if (!('session' in response)) checks.push('missing session');
  if (checks.length === 0) {
    record('ping/pong', true, `pid=${response.pid}, ready=${response.ready}, session=${response.session}`);
  } else {
    record('ping/pong', false, checks.join('; '));
  }
}

async function testUnknownOp() {
  log('--- Test 5: unknown op error ---');
  const { response } = await sendAndReceive('{"op":"unknown_op"}');
  if (response && response.type === 'bridge_error' && response.message === 'Unknown op: unknown_op') {
    record('unknown op', true, 'Correct error response');
  } else {
    record('unknown op', false, `Unexpected: ${JSON.stringify(response)}`);
  }
}

async function testInvalidJSON() {
  log('--- Test 6: invalid JSON error ---');
  const { response } = await sendAndReceive('not json');
  if (response && response.type === 'bridge_error' && response.message === 'Invalid JSON input') {
    record('invalid JSON', true, 'Correct error response');
  } else {
    record('invalid JSON', false, `Unexpected: ${JSON.stringify(response)}`);
  }
}

async function testBridgeSignalReceivedFields() {
  log('--- Test 7: bridge_signal_received event fields ---');
  // For this test, do NOT filter bridge_signal_received — we need to inspect it
  const child = spawn(process.execPath, [BRIDGE_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = await new Promise((resolve) => {
    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    setTimeout(() => child.kill('SIGTERM'), 500);

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve(stdout.split('\n').filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
      }
    });

    const timer = setTimeout(() => { if (!resolved) { resolved = true; child.kill('SIGKILL'); resolve([]); } }, TIMEOUT_MS);
    child.on('exit', () => clearTimeout(timer));
  });

  const signalEvent = events.find(e => e.type === 'bridge_signal_received');
  if (!signalEvent) {
    record('bridge_signal_received fields', false, `No bridge_signal_received event. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }
  const checks = [];
  if (typeof signalEvent.signal !== 'string') checks.push('missing/invalid signal');
  if (typeof signalEvent.pendingCalls !== 'number') checks.push('missing/invalid pendingCalls');
  if (typeof signalEvent.timestamp !== 'string') checks.push('missing/invalid timestamp');
  if (typeof signalEvent.deferred !== 'boolean') checks.push('missing/invalid deferred');
  if (checks.length === 0) {
    record('bridge_signal_received fields', true, `signal=${signalEvent.signal}, pendingCalls=${signalEvent.pendingCalls}, deferred=${signalEvent.deferred}`);
  } else {
    record('bridge_signal_received fields', false, checks.join('; '));
  }
}

async function main() {
  log('Starting absorption scope preservation property tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: All tests PASS on both unfixed and fixed code\n');

  await testNoSessionSigterm();
  await testSigintShutdown();
  await testOpStop();
  await testPingPong();
  await testUnknownOp();
  await testInvalidJSON();
  await testBridgeSignalReceivedFields();

  console.log('\n========== SUMMARY ==========');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.detail}`);
    if (!r.passed) allPassed = false;
  }
  console.log('=============================\n');

  if (allPassed) {
    log('All preservation tests passed — baseline behavior confirmed.');
    process.exit(0);
  } else {
    log('Some preservation tests FAILED — baseline behavior broken.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
