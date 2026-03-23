#!/usr/bin/env node

/**
 * Bridge Stdio Lifecycle — Preservation Property Tests
 *
 * Verifies that bridge code and behavior are UNCHANGED before and after the doc fix.
 * All tests MUST PASS on both unfixed and fixed documentation.
 *
 * Tests:
 * 1. Bridge code file exists and contains key functions
 * 2. Bridge ping/pong works (stdio mode)
 * 3. Bridge FIFO mode works (--control fifo)
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 5000;

const results = [];

function log(msg) {
  console.log(`[stdio-lifecycle-pres] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

/**
 * Test 1: Bridge code file exists and is readable
 *
 * Read scripts/kiro-acp-bridge.js, verify it exists, compute SHA256,
 * and confirm it contains key functions: gracefulShutdown, processCommand, setupFifoControl.
 *
 * Validates: Requirements 3.1, 3.8
 */
function testBridgeCodeExists() {
  log('--- Test 1: Bridge code file exists and contains key functions ---');

  let content;
  try {
    content = fs.readFileSync(BRIDGE_PATH, 'utf8');
  } catch (err) {
    record('bridge code exists', false, `Cannot read bridge file: ${err.message}`);
    return;
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  log(`  SHA256: ${hash}`);
  log(`  Size: ${content.length} bytes`);

  const requiredFunctions = ['gracefulShutdown', 'processCommand', 'setupFifoControl'];
  const missing = requiredFunctions.filter(fn => !content.includes(fn));

  if (missing.length === 0) {
    record('bridge code exists', true, `File readable, SHA256=${hash.slice(0, 16)}..., all ${requiredFunctions.length} key functions present`);
  } else {
    record('bridge code exists', false, `Missing functions: ${missing.join(', ')}`);
  }
}

/**
 * Helper: spawn bridge in stdio mode, send a line, collect first meaningful JSON response.
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

/**
 * Test 2: Bridge ping/pong works (stdio mode)
 *
 * Spawn bridge, send {"op":"ping"}, verify pong response.
 * Filters control_channel, heartbeat, bridge_signal_received events.
 *
 * Validates: Requirements 3.1, 3.2, 3.7
 */
async function testPingPong() {
  log('--- Test 2: Bridge ping/pong works ---');
  const { response } = await sendAndReceive('{"op":"ping"}');

  if (!response) {
    record('ping/pong', false, 'No response received');
    return;
  }

  const checks = [];
  if (response.type !== 'pong') checks.push(`type="${response.type}" (expected "pong")`);
  if (typeof response.ready !== 'boolean') checks.push(`ready=${response.ready} (expected boolean)`);
  if (!('session' in response)) checks.push('missing "session" field');

  if (checks.length === 0) {
    record('ping/pong', true, `type=pong, pid=${response.pid}, ready=${response.ready}, session=${response.session}`);
  } else {
    record('ping/pong', false, checks.join('; '));
  }
}

/**
 * Test 3: Bridge FIFO mode works
 *
 * Spawn bridge with --control fifo --control-path /tmp/test-stdio-lifecycle-XXXX.fifo,
 * send a ping via FIFO, verify pong response via stdout. Clean up FIFO after test.
 *
 * Validates: Requirements 3.2, 3.3, 3.5, 3.6
 */
async function testFifoMode() {
  log('--- Test 3: Bridge FIFO mode works ---');

  const fifoPath = `/tmp/test-stdio-lifecycle-${process.pid}.fifo`;

  // Clean up any leftover FIFO from previous runs
  try { fs.unlinkSync(fifoPath); } catch { /* ignore */ }

  const child = spawn(process.execPath, [BRIDGE_PATH, '--control', 'fifo', '--control-path', fifoPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    const response = await new Promise((resolve) => {
      let stdout = '';
      let resolved = false;
      let fifoReady = false;

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const lines = stdout.split('\n').filter(l => l.trim());

        // Wait for control_channel event before writing to FIFO
        if (!fifoReady) {
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'control_channel' && obj.mode === 'fifo') {
                fifoReady = true;
                // Send ping via FIFO
                try {
                  fs.writeFileSync(fifoPath, '{"op":"ping"}\n');
                } catch (err) {
                  if (!resolved) { resolved = true; child.kill('SIGKILL'); resolve({ error: `FIFO write failed: ${err.message}` }); }
                  return;
                }
              }
            } catch { /* not json */ }
          }
        }

        // Look for pong response
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'control_channel' || obj.type === 'heartbeat' || obj.type === 'bridge_signal_received') continue;
            if (obj.type === 'pong' && !resolved) {
              resolved = true;
              child.kill('SIGKILL');
              resolve({ response: obj });
            }
          } catch { /* not json yet */ }
        }
      });

      child.on('exit', () => {
        if (!resolved) {
          resolved = true;
          resolve({ response: null });
        }
      });

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          child.kill('SIGKILL');
          resolve({ response: null, timeout: true });
        }
      }, TIMEOUT_MS);
      child.on('exit', () => clearTimeout(timer));
    });

    if (response.error) {
      record('FIFO mode', false, response.error);
      return;
    }

    if (!response.response) {
      record('FIFO mode', false, response.timeout ? 'Timed out waiting for pong' : 'No pong response');
      return;
    }

    const r = response.response;
    const checks = [];
    if (r.type !== 'pong') checks.push(`type="${r.type}" (expected "pong")`);
    if (typeof r.ready !== 'boolean') checks.push(`ready=${r.ready} (expected boolean)`);
    if (!('session' in r)) checks.push('missing "session" field');

    if (checks.length === 0) {
      record('FIFO mode', true, `type=pong via FIFO, pid=${r.pid}, ready=${r.ready}`);
    } else {
      record('FIFO mode', false, checks.join('; '));
    }
  } finally {
    // Clean up FIFO
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.unlinkSync(fifoPath); } catch { /* ignore */ }
  }
}

async function main() {
  log('Starting stdio lifecycle preservation property tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: All tests PASS on both unfixed and fixed docs\n');

  testBridgeCodeExists();
  await testPingPong();
  await testFifoMode();

  console.log('\n========== SUMMARY ==========');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.detail}`);
    if (!r.passed) allPassed = false;
  }
  console.log('=============================\n');

  if (allPassed) {
    log('All preservation tests passed — bridge behavior confirmed unchanged.');
    process.exit(0);
  } else {
    log('Some preservation tests FAILED — bridge behavior may have changed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
