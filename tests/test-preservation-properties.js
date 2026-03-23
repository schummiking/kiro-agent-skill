#!/usr/bin/env node

/**
 * Preservation Property Tests — JSONL Command Response Baseline
 *
 * Verifies existing JSONL command behavior of scripts/kiro-acp-bridge.js.
 * These tests establish the baseline behavior that MUST be preserved after the fix.
 *
 * Each test spawns a fresh bridge process, sends a command via stdin,
 * reads stdout for the response, asserts the response matches expected format,
 * and cleans up the process.
 *
 * EXPECTED: All tests PASS on the current UNFIXED code.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 5000;

const results = [];

function log(msg) {
  console.log(`[preservation] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  log(`${status}: ${name} — ${detail}`);
}

/**
 * Helper: spawn bridge, send a line via stdin, collect first JSON response from stdout.
 * Returns the parsed JSON object or null if no response within timeout.
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
      // Check if we have a complete JSON line
      const lines = stdout.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (!resolved) {
            resolved = true;
            child.kill('SIGKILL');
            resolve({ response: obj, raw: line });
          }
          return;
        } catch {
          // Not valid JSON yet, keep collecting
        }
      }
    });

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        // Try to parse any remaining stdout
        const lines = stdout.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            resolve({ response: obj, raw: line });
            return;
          } catch {
            // ignore
          }
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

    // Send the input line
    if (inputLine !== null) {
      child.stdin.write(inputLine + '\n');
    }
  });
}

/**
 * Helper: spawn bridge, send a line, wait briefly, assert NO response on stdout.
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

    // Send the input line
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
 * Test 1: ping command
 * Send {"op":"ping"} → response type is "pong" with fields: pid, ready, session, initializeResult, sessions
 *
 * **Validates: Requirements 3.4**
 */
async function testPing() {
  log('--- Test 1: ping command ---');
  const { response } = await sendAndReceive('{"op":"ping"}');

  if (!response) {
    record('ping command', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'pong') checks.push(`type="${response.type}" (expected "pong")`);
  if (!('pid' in response)) checks.push('missing "pid" field');
  if (!('ready' in response)) checks.push('missing "ready" field');
  if (!('session' in response)) checks.push('missing "session" field');
  if (!('initializeResult' in response)) checks.push('missing "initializeResult" field');
  if (!('sessions' in response)) checks.push('missing "sessions" field');

  if (checks.length === 0) {
    record('ping command', true, `type=pong, pid=${response.pid}, ready=${response.ready}`);
  } else {
    record('ping command', false, checks.join('; '));
  }
}

/**
 * Test 2: stop command (no ACP running)
 * Send {"op":"stop"} → response type is "stop_requested" with session and pid fields
 *
 * **Validates: Requirements 3.3**
 */
async function testStop() {
  log('--- Test 2: stop command (no ACP) ---');
  const { response } = await sendAndReceive('{"op":"stop"}');

  if (!response) {
    record('stop command', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'stop_requested') checks.push(`type="${response.type}" (expected "stop_requested")`);
  if (!('session' in response)) checks.push('missing "session" field');
  if (!('pid' in response)) checks.push('missing "pid" field');

  if (checks.length === 0) {
    record('stop command', true, `type=stop_requested, session=${response.session}, pid=${response.pid}`);
  } else {
    record('stop command', false, checks.join('; '));
  }
}

/**
 * Test 3: unknown op
 * Send {"op":"unknown_op"} → response type is "bridge_error" with message containing "unknown_op"
 *
 * **Validates: Requirements 3.1**
 */
async function testUnknownOp() {
  log('--- Test 3: unknown op ---');
  const { response } = await sendAndReceive('{"op":"unknown_op"}');

  if (!response) {
    record('unknown op', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}" (expected "bridge_error")`);
  if (typeof response.message !== 'string' || !response.message.includes('unknown_op')) {
    checks.push(`message="${response.message}" (expected to contain "unknown_op")`);
  }

  if (checks.length === 0) {
    record('unknown op', true, `type=bridge_error, message="${response.message}"`);
  } else {
    record('unknown op', false, checks.join('; '));
  }
}

/**
 * Test 4: invalid JSON
 * Send "not json" → response type is "bridge_error" with message "Invalid JSON input"
 *
 * **Validates: Requirements 3.1**
 */
async function testInvalidJSON() {
  log('--- Test 4: invalid JSON ---');
  const { response } = await sendAndReceive('not json');

  if (!response) {
    record('invalid JSON', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}" (expected "bridge_error")`);
  if (response.message !== 'Invalid JSON input') {
    checks.push(`message="${response.message}" (expected "Invalid JSON input")`);
  }

  if (checks.length === 0) {
    record('invalid JSON', true, `type=bridge_error, message="${response.message}"`);
  } else {
    record('invalid JSON', false, checks.join('; '));
  }
}

/**
 * Test 5: send without ACP running (and no session)
 * Send {"op":"send","text":"hello"} → response type is "bridge_error"
 * Note: The bridge checks ACP readiness before session, so the actual error
 * on cold start is "ACP is not ready" (not "No session id").
 * This test captures the real baseline behavior via observation-first methodology.
 *
 * **Validates: Requirements 3.1**
 */
async function testSendWithoutSession() {
  log('--- Test 5: send without ACP/session ---');
  const { response } = await sendAndReceive('{"op":"send","text":"hello"}');

  if (!response) {
    record('send without session', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}" (expected "bridge_error")`);
  // Bridge checks acpReady first, so without a running ACP the error is "ACP is not ready"
  if (typeof response.message !== 'string' || !response.message.includes('ACP is not ready')) {
    checks.push(`message="${response.message}" (expected to contain "ACP is not ready")`);
  }
  if (!('op' in response)) checks.push('missing "op" field');

  if (checks.length === 0) {
    record('send without session', true, `type=bridge_error, op=${response.op}, message="${response.message}"`);
  } else {
    record('send without session', false, checks.join('; '));
  }
}

/**
 * Test 6: empty line
 * Send empty line → no response (ignored)
 *
 * **Validates: Requirements 3.1**
 */
async function testEmptyLine() {
  log('--- Test 6: empty line ---');
  const { raw } = await sendAndExpectNoResponse('');

  // Filter out any heartbeat or other background events that might appear
  // on fixed code — we only care that the empty line itself produces no response
  const lines = raw.split('\n').filter((l) => l.trim());
  const nonHeartbeatLines = lines.filter((l) => {
    try {
      const obj = JSON.parse(l);
      return obj.type !== 'heartbeat';
    } catch {
      return true;
    }
  });

  if (nonHeartbeatLines.length === 0) {
    record('empty line', true, 'No response for empty line (correct)');
  } else {
    record('empty line', false, `Unexpected output: ${raw}`);
  }
}

async function main() {
  log('Starting preservation property tests on bridge');
  log(`Bridge: ${BRIDGE_PATH}\n`);

  await testPing();
  await testStop();
  await testUnknownOp();
  await testInvalidJSON();
  await testSendWithoutSession();
  await testEmptyLine();

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
    log('Some preservation tests FAILED — baseline behavior not matching expectations.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
