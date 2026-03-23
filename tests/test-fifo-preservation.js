#!/usr/bin/env node

/**
 * FIFO Preservation Property Tests — stdio mode baseline behavior
 *
 * Verifies that stdio mode behavior is unchanged BEFORE implementing the FIFO fix.
 * These tests establish the baseline that MUST be preserved after the fix.
 *
 * Each test spawns a fresh bridge process (default stdio mode), sends a command
 * via stdin, reads stdout for the response, and asserts the response matches
 * expected format.
 *
 * EXPECTED: All tests PASS on the current UNFIXED code.
 *
 * Validates: Requirements 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 5000;

const results = [];

function log(msg) {
  console.log(`[fifo-preservation] ${msg}`);
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
      const lines = stdout.split('\n').filter((l) => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // Skip control_channel and heartbeat events — not part of command responses
          if (obj.type === 'control_channel' || obj.type === 'heartbeat') continue;
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
        const lines = stdout.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'control_channel' || obj.type === 'heartbeat') continue;
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
 * Helper: spawn bridge, collect all stdout events until timeout or exit.
 * Sends SIGTERM after a delay to trigger graceful shutdown.
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

    // Send SIGTERM after delay
    setTimeout(() => {
      child.kill('SIGTERM');
    }, delayMs);

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        const events = stdout
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          })
          .filter(Boolean);
        resolve({ events, raw: stdout });
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        const events = stdout
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => {
            try { return JSON.parse(l); } catch { return null; }
          })
          .filter(Boolean);
        resolve({ events, raw: stdout });
      }
    }, timeoutMs);

    child.on('exit', () => clearTimeout(timer));
  });
}

/**
 * Test 1+7: ping response format AND no controlMode/controlPath fields
 *
 * Send {"op":"ping"} → verify response is
 *   {"type":"pong","pid":null,"ready":false,"session":...,"initializeResult":null,"sessions":{}}
 * AND verify response does NOT contain controlMode or controlPath fields (stdio mode preservation).
 *
 * **Validates: Requirements 2.5, 3.6**
 */
async function testPingResponseFormat() {
  log('--- Test 1+7: ping response format & no controlMode/controlPath ---');
  const { response } = await sendAndReceive('{"op":"ping"}');

  if (!response) {
    record('ping response format', false, 'No response received');
    return;
  }

  const checks = [];

  // Verify type
  if (response.type !== 'pong') checks.push(`type="${response.type}" (expected "pong")`);

  // Verify expected fields exist with correct baseline values
  if (response.pid !== null) checks.push(`pid=${response.pid} (expected null)`);
  if (response.ready !== false) checks.push(`ready=${response.ready} (expected false)`);
  if (!('session' in response)) checks.push('missing "session" field');
  if (response.initializeResult !== null) checks.push(`initializeResult=${JSON.stringify(response.initializeResult)} (expected null)`);
  if (!('sessions' in response) || typeof response.sessions !== 'object') {
    checks.push('missing or invalid "sessions" field');
  }

  // Verify NO controlMode or controlPath fields (stdio mode preservation)
  if ('controlMode' in response) checks.push(`unexpected "controlMode" field: ${response.controlMode}`);
  if ('controlPath' in response) checks.push(`unexpected "controlPath" field: ${response.controlPath}`);

  if (checks.length === 0) {
    record('ping response format', true, 'type=pong, correct fields, no controlMode/controlPath');
  } else {
    record('ping response format', false, checks.join('; '));
  }
}

/**
 * Test 2: stop command
 *
 * Send {"op":"stop"} → verify {"type":"stop_requested","session":...,"pid":null}
 *
 * **Validates: Requirements 3.1, 3.3**
 */
async function testStopCommand() {
  log('--- Test 2: stop command ---');
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
 *
 * Send {"op":"unknown_op"} → verify {"type":"bridge_error","message":"Unknown op: unknown_op"}
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
  if (response.message !== 'Unknown op: unknown_op') {
    checks.push(`message="${response.message}" (expected "Unknown op: unknown_op")`);
  }

  if (checks.length === 0) {
    record('unknown op', true, `type=bridge_error, message="${response.message}"`);
  } else {
    record('unknown op', false, checks.join('; '));
  }
}

/**
 * Test 4: invalid JSON
 *
 * Send "not json" → verify {"type":"bridge_error","message":"Invalid JSON input"}
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
 * Test 5: send without ACP
 *
 * Send {"op":"send","text":"hello"} → verify {"type":"bridge_error","op":"send","message":"ACP is not ready"}
 *
 * **Validates: Requirements 3.1**
 */
async function testSendWithoutAcp() {
  log('--- Test 5: send without ACP ---');
  const { response } = await sendAndReceive('{"op":"send","text":"hello"}');

  if (!response) {
    record('send without ACP', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'bridge_error') checks.push(`type="${response.type}" (expected "bridge_error")`);
  if (response.op !== 'send') checks.push(`op="${response.op}" (expected "send")`);
  if (typeof response.message !== 'string' || !response.message.includes('ACP is not ready')) {
    checks.push(`message="${response.message}" (expected to contain "ACP is not ready")`);
  }

  if (checks.length === 0) {
    record('send without ACP', true, `type=bridge_error, op=send, message="${response.message}"`);
  } else {
    record('send without ACP', false, checks.join('; '));
  }
}

/**
 * Test 6: empty line
 *
 * Send empty line → verify no response (line is ignored)
 *
 * **Validates: Requirements 3.1**
 */
async function testEmptyLine() {
  log('--- Test 6: empty line ---');
  const { raw } = await sendAndExpectNoResponse('');

  const lines = raw.split('\n').filter((l) => l.trim());
  // Filter out heartbeat events that may appear during the wait
  const nonHeartbeatLines = lines.filter((l) => {
    try {
      const obj = JSON.parse(l);
      return obj.type !== 'heartbeat' && obj.type !== 'control_channel';
    } catch {
      return true;
    }
  });

  if (nonHeartbeatLines.length === 0) {
    record('empty line', true, 'No response for empty line (correct)');
  } else {
    record('empty line', false, `Unexpected output: ${nonHeartbeatLines.join(', ')}`);
  }
}

/**
 * Test 8: SIGTERM graceful shutdown
 *
 * Send SIGTERM → verify {"type":"shutdown","reason":"SIGTERM",...} event is emitted
 *
 * **Validates: Requirements 3.3**
 */
async function testSigtermShutdown() {
  log('--- Test 8: SIGTERM graceful shutdown ---');
  const { events } = await spawnAndSigterm(500, TIMEOUT_MS);

  const shutdownEvent = events.find((e) => e.type === 'shutdown');

  if (!shutdownEvent) {
    record('SIGTERM shutdown', false, `No shutdown event found. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }

  const checks = [];
  if (shutdownEvent.reason !== 'SIGTERM') checks.push(`reason="${shutdownEvent.reason}" (expected "SIGTERM")`);
  if (!('session' in shutdownEvent)) checks.push('missing "session" field');
  if (!('pid' in shutdownEvent)) checks.push('missing "pid" field');

  if (checks.length === 0) {
    record('SIGTERM shutdown', true, `type=shutdown, reason=SIGTERM, session=${shutdownEvent.session}, pid=${shutdownEvent.pid}`);
  } else {
    record('SIGTERM shutdown', false, checks.join('; '));
  }
}

async function main() {
  log('Starting FIFO preservation property tests on bridge (stdio mode baseline)');
  log(`Bridge: ${BRIDGE_PATH}\n`);

  await testPingResponseFormat();
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
    log('All FIFO preservation tests passed — stdio mode baseline confirmed.');
    process.exit(0);
  } else {
    log('Some FIFO preservation tests FAILED — baseline behavior not matching expectations.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
