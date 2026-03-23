#!/usr/bin/env node

/**
 * Bug Condition Exploration Test — Bridge Process Stability
 *
 * Tests four bug conditions in scripts/kiro-acp-bridge.js:
 *   1. stdin EOF → process should stay alive (bug: it exits)
 *   2. SIGTERM  → should emit shutdown event (bug: no event, process dies)
 *   3. SIGINT   → should emit shutdown event (bug: no event, process dies)
 *   4. Heartbeat → should emit heartbeat within 35s (bug: no heartbeat)
 *
 * EXPECTED: All checks FAIL on unfixed code (exit code 1).
 * Failure confirms the bugs exist.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');

const results = [];

function log(msg) {
  console.log(`[exploration] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  log(`${status}: ${name} — ${detail}`);
}

/**
 * Test 1: stdin EOF
 * Spawn bridge, close stdin immediately, wait 3 seconds, check if process is still running.
 * EXPECTED on unfixed code: process exits → test FAILs (proving bug 1.1 exists).
 */
function testStdinEOF() {
  return new Promise((resolve) => {
    log('--- Test 1: stdin EOF ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let exited = false;
    let exitCode = null;
    let exitSignal = null;

    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });

    // Close stdin immediately to trigger EOF
    child.stdin.end();

    setTimeout(() => {
      if (!exited) {
        // Process is still running — expected behavior (fix applied)
        record('stdin EOF', true, 'Process still running after stdin EOF (good)');
        child.kill('SIGKILL');
      } else {
        // Process exited — bug exists
        record('stdin EOF', false, `Process exited (code=${exitCode}, signal=${exitSignal}) after stdin EOF`);
      }
      resolve();
    }, 3000);
  });
}

/**
 * Test 2: SIGTERM
 * Spawn bridge, send SIGTERM, check stdout for a "shutdown" event.
 * EXPECTED on unfixed code: no shutdown event → test FAILs (proving bug 1.2 exists).
 */
function testSIGTERM() {
  return new Promise((resolve) => {
    log('--- Test 2: SIGTERM ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    let exited = false;
    child.on('exit', () => { exited = true; });

    // Give the process a moment to start, then send SIGTERM
    setTimeout(() => {
      child.kill('SIGTERM');
    }, 500);

    // Wait for process to exit or timeout
    setTimeout(() => {
      const hasShutdownEvent = stdout.split('\n').some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.type === 'shutdown';
        } catch {
          return false;
        }
      });

      if (hasShutdownEvent) {
        record('SIGTERM shutdown event', true, 'Shutdown event found in stdout (good)');
      } else {
        record('SIGTERM shutdown event', false, `No shutdown event in stdout. Exited=${exited}. Output: ${stdout.trim() || '(empty)'}`);
      }

      if (!exited) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

/**
 * Test 3: SIGINT
 * Spawn bridge, send SIGINT, check stdout for a "shutdown" event.
 * EXPECTED on unfixed code: no shutdown event → test FAILs (proving bug 1.3 exists).
 */
function testSIGINT() {
  return new Promise((resolve) => {
    log('--- Test 3: SIGINT ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    let exited = false;
    child.on('exit', () => { exited = true; });

    // Give the process a moment to start, then send SIGINT
    setTimeout(() => {
      child.kill('SIGINT');
    }, 500);

    // Wait for process to exit or timeout
    setTimeout(() => {
      const hasShutdownEvent = stdout.split('\n').some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.type === 'shutdown';
        } catch {
          return false;
        }
      });

      if (hasShutdownEvent) {
        record('SIGINT shutdown event', true, 'Shutdown event found in stdout (good)');
      } else {
        record('SIGINT shutdown event', false, `No shutdown event in stdout. Exited=${exited}. Output: ${stdout.trim() || '(empty)'}`);
      }

      if (!exited) child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

/**
 * Test 4: Heartbeat
 * Spawn bridge, wait 35 seconds, check stdout for a "heartbeat" event.
 * EXPECTED on unfixed code: no heartbeat → test FAILs (proving bug 1.4 exists).
 */
function testHeartbeat() {
  return new Promise((resolve) => {
    log('--- Test 4: Heartbeat (waiting 35s) ---');
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    let exited = false;
    let exitCode = null;
    let exitSignal = null;
    child.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
    });

    setTimeout(() => {
      const hasHeartbeat = stdout.split('\n').some((line) => {
        try {
          const obj = JSON.parse(line);
          return obj.type === 'heartbeat';
        } catch {
          return false;
        }
      });

      if (hasHeartbeat) {
        record('Heartbeat', true, 'Heartbeat event found in stdout (good)');
      } else {
        if (exited) {
          record('Heartbeat', false, `No heartbeat — process exited early (code=${exitCode}, signal=${exitSignal})`);
        } else {
          record('Heartbeat', false, `No heartbeat event in stdout after 35s. Output: ${stdout.trim() || '(empty)'}`);
        }
      }

      if (!exited) child.kill('SIGKILL');
      resolve();
    }, 35000);
  });
}

async function main() {
  log('Starting bug condition exploration tests on UNFIXED bridge code');
  log(`Bridge: ${BRIDGE_PATH}\n`);

  await testStdinEOF();
  await testSIGTERM();
  await testSIGINT();
  await testHeartbeat();

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
