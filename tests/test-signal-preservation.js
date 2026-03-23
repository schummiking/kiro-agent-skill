#!/usr/bin/env node

/**
 * ACP Signal Isolation — Preservation Property Tests
 *
 * Verifies that existing bridge behaviors are UNCHANGED before and after the fix.
 * These tests establish the baseline that MUST be preserved.
 *
 * Tests:
 * 1. ping/pong response format
 * 2. stop command behavior
 * 3. unknown op error
 * 4. invalid JSON error
 * 5. send without ACP error
 * 6. empty line ignored
 * 7. SIGTERM shutdown event
 *
 * EXPECTED: All tests PASS on both unfixed and fixed code.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 5000;

const results = [];

function log(msg) {
  console.log(`[signal-preservation] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  log(`${status}: ${name} — ${detail}`);
}

/**
 * Helper: spawn bridge, send a line via stdin, collect first non-system JSON response.
 * Filters out control_channel and heartbeat events.
 */
function sendAndReceive(inputLine, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // Skip system events — not part of command responses
          if (obj.type === 'control_channel' || obj.type === 'heartbeat' || obj.type === 'bridge_signal_received') continue;
          if (!resolved) {
            resolved = true;
            child.kill('SIGKILL');
            resolve({ response: obj, raw: line });
          }
          return;
        } catch {
          // Not valid JSON yet
        }
      }
    });

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        const lines = stdout.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'control_channel' || obj.type === 'heartbeat' || obj.type === 'bridge_signal_received') continue;
            resolve({ response: obj, raw: line });
            return;
          } catch { /* ignore */ }
        }
        resolve({ response: null, raw: stdout });
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        resolve({ response: null, raw: stdout });
      }
    }, timeoutMs);

    child.on('exit', () => clearTimeout(timer));

    if (inputLine !== null) {
      child.stdin.write(inputLine + '\n');
    }
  });
}

/**
 * Helper: spawn bridge, send a line, wait briefly, assert NO command response on stdout.
 */
function sendAndExpectNoResponse(inputLine, waitMs = 2000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    if (inputLine !== null) {
      child.stdin.write(inputLine + '\n');
    }

    setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ raw: stdout.trim() });
    }, waitMs);
  });
}

/**
 * Helper: spawn bridge, send SIGTERM after delay, collect all events.
 */
function spawnAndSigterm(delayMs = 500, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    setTimeout(() => {
      child.kill('SIGTERM');
    }, delayMs);

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        resolve(parseEvents(stdout));
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        resolve(parseEvents(stdout));
      }
    }, timeoutMs);

    child.on('exit', () => clearTimeout(timer));
  });
}

function parseEvents(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

// ---- Tests ----

async function testPingPong() {
  log('--- Test 1: ping/pong response format ---');
  const { response } = await sendAndReceive('{"op":"ping"}');

  if (!response) {
    record('ping/pong', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'pong') checks.push(`type="${response.type}"`);
  if (response.pid !== null) checks.push(`pid=${response.pid}`);
  if (response.ready !== false) checks.push(`ready=${response.ready}`);
  if (!('session' in response)) checks.push('missing session');
  if (response.initializeResult !== null) checks.push('initializeResult not null');
  if (!('sessions' in response)) checks.push('missing sessions');

  if (checks.length === 0) {
    record('ping/pong', true, 'type=pong, correct baseline fields');
  } else {
    record('ping/pong', false, checks.join('; '));
  }
}

async function testStopCommand() {
  log('--- Test 2: stop command ---');
  const { response } = await sendAndReceive('{"op":"stop"}');

  if (!response) {
    record('stop command', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'stop_requested') checks.push(`type="${response.type}"`);
  if (!('session' in response)) checks.push('missing session');
  if (!('pid' in response)) checks.push('missing pid');

  if (checks.length === 0) {
    record('stop command', true, `type=stop_requested, session=${response.session}, pid=${response.pid}`);
  } else {
    record('stop command', false, checks.join('; '));
  }
}

async function testUnknownOp() {
  log('--- Test 3: unknown op ---');
  const { response } = await sendAndReceive('{"op":"unknown_op"}');

  if (!response) {
    record('unknown op', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}"`);
  if (response.message !== 'Unknown op: unknown_op') checks.push(`message="${response.message}"`);

  if (checks.length === 0) {
    record('unknown op', true, 'bridge_error with correct message');
  } else {
    record('unknown op', false, checks.join('; '));
  }
}

async function testInvalidJSON() {
  log('--- Test 4: invalid JSON ---');
  const { response } = await sendAndReceive('not json');

  if (!response) {
    record('invalid JSON', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}"`);
  if (response.message !== 'Invalid JSON input') checks.push(`message="${response.message}"`);

  if (checks.length === 0) {
    record('invalid JSON', true, 'bridge_error with correct message');
  } else {
    record('invalid JSON', false, checks.join('; '));
  }
}

async function testSendWithoutAcp() {
  log('--- Test 5: send without ACP ---');
  const { response } = await sendAndReceive('{"op":"send","text":"hello"}');

  if (!response) {
    record('send without ACP', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}"`);
  if (response.op !== 'send') checks.push(`op="${response.op}"`);
  if (!response.message || !response.message.includes('ACP is not ready')) {
    checks.push(`message="${response.message}"`);
  }

  if (checks.length === 0) {
    record('send without ACP', true, 'bridge_error, ACP is not ready');
  } else {
    record('send without ACP', false, checks.join('; '));
  }
}

async function testEmptyLine() {
  log('--- Test 6: empty line ---');
  const { raw } = await sendAndExpectNoResponse('');

  const lines = raw.split('\n').filter((l) => l.trim());
  const nonSystemLines = lines.filter((l) => {
    try {
      const obj = JSON.parse(l);
      return obj.type !== 'heartbeat' && obj.type !== 'control_channel' && obj.type !== 'bridge_signal_received';
    } catch {
      return true;
    }
  });

  if (nonSystemLines.length === 0) {
    record('empty line', true, 'No response for empty line (correct)');
  } else {
    record('empty line', false, `Unexpected output: ${nonSystemLines.join(', ')}`);
  }
}

async function testSigtermShutdown() {
  log('--- Test 7: SIGTERM shutdown event ---');
  const events = await spawnAndSigterm(500, TIMEOUT_MS);

  const shutdownEvent = events.find((e) => e.type === 'shutdown');

  if (!shutdownEvent) {
    record('SIGTERM shutdown', false, `No shutdown event. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }

  const checks = [];
  if (shutdownEvent.reason !== 'SIGTERM') checks.push(`reason="${shutdownEvent.reason}"`);
  if (!('session' in shutdownEvent)) checks.push('missing session');
  if (!('pid' in shutdownEvent)) checks.push('missing pid');

  if (checks.length === 0) {
    record('SIGTERM shutdown', true, `type=shutdown, reason=SIGTERM`);
  } else {
    record('SIGTERM shutdown', false, checks.join('; '));
  }
}

async function main() {
  log('Starting ACP signal isolation preservation property tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: All tests PASS on both unfixed and fixed code\n');

  await testPingPong();
  await testStopCommand();
  await testUnknownOp();
  await testInvalidJSON();
  await testSendWithoutAcp();
  await testEmptyLine();
  await testSigtermShutdown();

  // Summary
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
