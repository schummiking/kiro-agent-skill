#!/usr/bin/env node

/**
 * Bug Condition Exploration Test — FIFO Control Channel Support
 *
 * Tests three bug conditions in scripts/kiro-acp-bridge.js:
 *   1. FIFO param ignored: --control fifo does not create a FIFO file
 *   2. stdin close zombie: after stdin closes, bridge cannot receive commands
 *   3. No control_channel event: bridge does not emit control_channel event at startup
 *
 * EXPECTED: All checks FAIL on unfixed code (exit code 1).
 * Failure confirms the bugs exist.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 2.1, 2.3
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');

const results = [];

function log(msg) {
  console.log(`[fifo-exploration] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  log(`${status}: ${name} — ${detail}`);
}

/**
 * Test 1: FIFO param ignored
 * Start bridge with --control fifo --control-path /tmp/test-fifo-<pid>.fifo
 * Verify bridge creates a FIFO file at the specified path.
 * EXPECTED on unfixed code: no FIFO file created → test FAILs (proving bug exists).
 *
 * **Validates: Requirements 1.1, 2.1**
 */
function testFifoParamIgnored() {
  return new Promise((resolve) => {
    log('--- Test 1: FIFO param ignored ---');
    const fifoPath = `/tmp/test-fifo-${process.pid}.fifo`;

    // Clean up any leftover file
    try { fs.unlinkSync(fifoPath); } catch {}

    const child = spawn(process.execPath, [
      BRIDGE_PATH,
      '--control', 'fifo',
      '--control-path', fifoPath,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wait 2 seconds for bridge to start and potentially create the FIFO
    setTimeout(() => {
      const fifoExists = fs.existsSync(fifoPath);

      if (fifoExists) {
        record('FIFO param ignored', true, `FIFO file created at ${fifoPath} (bridge supports --control fifo)`);
        // Clean up
        try { fs.unlinkSync(fifoPath); } catch {}
      } else {
        record('FIFO param ignored', false, `No FIFO file at ${fifoPath} — bridge ignores --control fifo parameter`);
      }

      child.kill('SIGKILL');
      resolve();
    }, 2000);

    child.on('error', (err) => {
      record('FIFO param ignored', false, `Bridge spawn error: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Test 2: stdin close zombie
 * Start bridge, close stdin immediately, wait 1s, then verify the bridge
 * has no way to receive commands (since stdin is the only control channel
 * in unfixed code and it's now closed).
 * EXPECTED on unfixed code: after stdin closes, bridge cannot receive ping → test FAILs.
 *
 * **Validates: Requirements 1.2, 1.3**
 */
function testStdinCloseZombie() {
  return new Promise((resolve) => {
    log('--- Test 2: stdin close zombie ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    // Close stdin immediately — bridge loses its only control channel
    child.stdin.end();

    // Wait 1 second, then try to check if we can still communicate
    setTimeout(() => {
      // stdin is already closed, so we can't write to it.
      // The bridge is now in zombie state — it's alive but uncontrollable.
      // To prove the bug, we check that there's no way to send a ping.
      // A fixed bridge would have an alternative control channel (FIFO).
      // On unfixed code, stdin is the ONLY way in, and it's closed.

      // We verify the bridge is still running but uncontrollable:
      // - No pong response possible (can't send ping via closed stdin)
      // - The bridge should still be alive (keepalive timer)
      const hasPong = stdout.split('\n').some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.type === 'pong';
        } catch {
          return false;
        }
      });

      // For the test to PASS, we'd need an alternative control channel
      // that allows sending commands after stdin closes.
      // On unfixed code, there's no such channel, so this fails.
      if (!hasPong) {
        // This is expected on unfixed code — bridge is uncontrollable after stdin close
        record('stdin close zombie', false, 'Bridge uncontrollable after stdin close — no alternative control channel to send ping');
      } else {
        record('stdin close zombie', true, 'Bridge responded to ping via alternative channel after stdin close');
      }

      child.kill('SIGKILL');
      resolve();
    }, 2000);

    child.on('error', (err) => {
      record('stdin close zombie', false, `Bridge spawn error: ${err.message}`);
      resolve();
    });
  });
}

/**
 * Test 3: No control_channel event
 * Start bridge, collect stdout for ~2 seconds, check if any line contains
 * a {"type":"control_channel",...} event.
 * EXPECTED on unfixed code: no such event → test FAILs (proving bug exists).
 *
 * **Validates: Requirements 2.3**
 */
function testNoControlChannelEvent() {
  return new Promise((resolve) => {
    log('--- Test 3: No control_channel event ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    // Wait 2 seconds to collect startup output
    setTimeout(() => {
      const hasControlChannelEvent = stdout.split('\n').some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.type === 'control_channel';
        } catch {
          return false;
        }
      });

      if (hasControlChannelEvent) {
        record('No control_channel event', true, 'control_channel event found in stdout (bridge reports its control channel)');
      } else {
        record('No control_channel event', false, `No control_channel event in stdout. Output: ${stdout.trim() || '(empty)'}`);
      }

      child.kill('SIGKILL');
      resolve();
    }, 2000);

    child.on('error', (err) => {
      record('No control_channel event', false, `Bridge spawn error: ${err.message}`);
      resolve();
    });
  });
}

async function main() {
  log('Starting bug condition exploration tests on UNFIXED bridge code');
  log(`Bridge: ${BRIDGE_PATH}\n`);

  await testFifoParamIgnored();
  await testStdinCloseZombie();
  await testNoControlChannelEvent();

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
    log('All checks passed — expected behavior is present (bugs may be fixed already).');
    process.exit(0);
  } else {
    log('Some checks failed — this CONFIRMS the bugs exist on unfixed code.');
    log('This is the EXPECTED outcome for the exploration test.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
