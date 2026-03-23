#!/usr/bin/env node

/**
 * SIGTERM Absorption Scope — Bug Condition Exploration Tests
 *
 * Verifies that the absorption condition bugs EXIST on unfixed code.
 * Tests 1-2 encode EXPECTED behavior (will FAIL on unfixed, PASS after fix).
 * Test 3 confirms baseline behavior (will PASS on both).
 *
 * Bug conditions tested:
 * 1. Absorption condition contains `currentSessionId` (overly strict)
 * 2. Absorption condition contains `pending.size === 0` (overly strict)
 * 3. (baseline) No-session SIGTERM still causes immediate shutdown
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 8000;

const results = [];

function log(msg) {
  console.log(`[absorption-scope-bug] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

/**
 * Find the SIGTERM absorption condition line in gracefulShutdown().
 * Returns the full `if (...)` line that contains the absorption logic.
 */
function findAbsorptionConditionLine() {
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const lines = src.split('\n');
  for (const line of lines) {
    // The absorption condition is the `if` that checks reason === 'SIGTERM' and sigTermCount
    if (line.includes('reason') && line.includes("'SIGTERM'") && line.includes('sigTermCount') && line.includes('acpReady')) {
      return line;
    }
  }
  return null;
}

/**
 * Test 1: Code check — absorption condition does NOT contain `currentSessionId`
 *
 * Validates: Requirements 1.1, 1.2
 * On unfixed code: FAIL (condition contains currentSessionId — bug confirmed)
 * On fixed code: PASS (condition no longer depends on session state)
 */
async function testNoCurrentSessionIdInCondition() {
  log('--- Test 1: absorption condition does NOT contain currentSessionId ---');
  const conditionLine = findAbsorptionConditionLine();

  if (!conditionLine) {
    record('no currentSessionId', false, 'Could not find absorption condition line in gracefulShutdown()');
    return;
  }

  log(`  Found condition: ${conditionLine.trim()}`);

  if (!conditionLine.includes('currentSessionId')) {
    record('no currentSessionId', true, 'Absorption condition does not contain currentSessionId');
  } else {
    record('no currentSessionId', false, `Absorption condition contains currentSessionId — overly strict condition confirmed`);
  }
}

/**
 * Test 2: Code check — absorption condition does NOT contain `pending.size === 0`
 *
 * Validates: Requirements 1.1, 1.2
 * On unfixed code: FAIL (condition contains pending.size === 0 — bug confirmed)
 * On fixed code: PASS (condition no longer depends on pending RPC count)
 */
async function testNoPendingSizeInCondition() {
  log('--- Test 2: absorption condition does NOT contain pending.size === 0 ---');
  const conditionLine = findAbsorptionConditionLine();

  if (!conditionLine) {
    record('no pending.size', false, 'Could not find absorption condition line in gracefulShutdown()');
    return;
  }

  log(`  Found condition: ${conditionLine.trim()}`);

  if (!conditionLine.includes('pending.size === 0')) {
    record('no pending.size', true, 'Absorption condition does not contain pending.size === 0');
  } else {
    record('no pending.size', false, `Absorption condition contains pending.size === 0 — overly strict condition confirmed`);
  }
}

/**
 * Test 3: Behavioral baseline — no-session SIGTERM causes immediate shutdown
 *
 * Validates: Requirements 3.1
 * On both unfixed and fixed code: PASS (acpReady is false, so SIGTERM always causes immediate shutdown)
 */
async function testNoSessionSigtermShutdown() {
  log('--- Test 3: no-session SIGTERM immediate shutdown (baseline) ---');

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    setTimeout(() => child.kill('SIGTERM'), 500);

    child.on('exit', () => {
      if (!resolved) {
        resolved = true;
        const events = stdout.split('\n').filter(l => l.trim()).map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean).filter(e =>
          e.type !== 'control_channel' && e.type !== 'heartbeat' && e.type !== 'bridge_signal_received'
        );
        resolve({ exited: true, events });
      }
    });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill('SIGKILL');
        resolve({ exited: false, events: [] });
      }
    }, TIMEOUT_MS);
    child.on('exit', () => clearTimeout(timer));
  });

  if (!result.exited) {
    record('no-session SIGTERM shutdown', false, 'Bridge did not exit after SIGTERM');
    return;
  }

  const shutdown = result.events.find(e => e.type === 'shutdown');
  if (shutdown && shutdown.reason === 'SIGTERM') {
    record('no-session SIGTERM shutdown', true, 'Bridge exited with shutdown event reason=SIGTERM (baseline confirmed)');
  } else {
    record('no-session SIGTERM shutdown', false, `No shutdown event or wrong reason. Events: ${JSON.stringify(result.events.map(e => e.type))}`);
  }
}

async function main() {
  log('Starting SIGTERM absorption scope bug condition exploration tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: Tests 1-2 FAIL on unfixed code, Test 3 PASS\n');

  await testNoCurrentSessionIdInCondition();
  await testNoPendingSizeInCondition();
  await testNoSessionSigtermShutdown();

  console.log('\n========== SUMMARY ==========');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.detail}`);
    if (!r.passed) allPassed = false;
  }
  console.log('=============================\n');

  if (allPassed) {
    log('All bug condition tests PASSED — bugs are FIXED.');
    process.exit(0);
  } else {
    log('Bug condition tests FAILED — bugs confirmed to exist (expected on unfixed code).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(2);
});
