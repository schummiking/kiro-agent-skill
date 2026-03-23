#!/usr/bin/env node

/**
 * Bridge Session Recovery — Bug Condition Exploration Tests
 *
 * Verifies that the SIGTERM absorption → FIFO recovery bugs EXIST on unfixed code.
 * Tests 1-3 encode EXPECTED behavior (will FAIL on unfixed, PASS after fix).
 * Test 4 confirms baseline behavior (will PASS on both).
 *
 * Bug conditions tested:
 * 1. SIGTERM absorption path (deferred:true) lacks setupFifoControl call
 * 2. Missing fifoFallbackCreated flag to prevent duplicate FIFO creation
 * 3. control_channel event lacks reason field near deferred branch
 * 4. (baseline) No-session SIGTERM still causes immediate shutdown
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 8000;

const results = [];

function log(msg) {
  console.log(`[session-recovery-bug] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

/**
 * Test 1: Code check — SIGTERM absorption path has setupFifoControl call
 *
 * We look for setupFifoControl being called in the vicinity of the
 * deferred:true / SIGTERM absorption branch inside gracefulShutdown().
 */
async function testFifoInAbsorptionPath() {
  log('--- Test 1: setupFifoControl in SIGTERM absorption path ---');
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');

  // Find the deferred:true absorption block and check if setupFifoControl is nearby
  const deferredIdx = src.indexOf('deferred: true');
  if (deferredIdx === -1) {
    record('FIFO in absorption path', false, 'deferred: true not found in source');
    return;
  }

  // Look for setupFifoControl within ~800 chars after deferred: true (the absorption block)
  const searchWindow = src.substring(deferredIdx, deferredIdx + 800);
  if (searchWindow.includes('setupFifoControl')) {
    record('FIFO in absorption path', true, 'setupFifoControl found near deferred:true branch');
  } else {
    record('FIFO in absorption path', false, 'setupFifoControl NOT found near deferred:true branch');
  }
}

/**
 * Test 2: Code check — fifoFallbackCreated flag exists
 */
async function testFifoFallbackCreatedFlag() {
  log('--- Test 2: fifoFallbackCreated flag ---');
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');

  if (src.includes('fifoFallbackCreated')) {
    record('fifoFallbackCreated flag', true, 'fifoFallbackCreated found in bridge source');
  } else {
    record('fifoFallbackCreated flag', false, 'fifoFallbackCreated NOT found in bridge source');
  }
}

/**
 * Test 3: Code check — control_channel event has reason field near deferred branch
 */
async function testReasonFieldInControlChannel() {
  log('--- Test 3: reason field in control_channel event ---');
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');

  if (src.includes('sigterm_recovery')) {
    record('reason field', true, 'sigterm_recovery reason found in bridge source');
  } else {
    record('reason field', false, 'sigterm_recovery reason NOT found in bridge source');
  }
}

/**
 * Test 4: Behavioral — no-session SIGTERM causes immediate shutdown (baseline)
 */
async function testNoSessionSigtermShutdown() {
  log('--- Test 4: no-session SIGTERM immediate shutdown ---');

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

    setTimeout(() => child.kill('SIGTERM'), 500);

    child.on('exit', () => {
      const events = stdout.split('\n').filter(l => l.trim()).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      resolve({ exited: true, events });
    });

    setTimeout(() => resolve({ exited: false, events: [] }), TIMEOUT_MS);
  });

  if (!result.exited) {
    record('no-session SIGTERM shutdown', false, 'Bridge did not exit after SIGTERM');
    return;
  }

  const shutdown = result.events.find(e => e.type === 'shutdown');
  if (shutdown && shutdown.reason === 'SIGTERM') {
    record('no-session SIGTERM shutdown', true, 'Bridge exited with shutdown event (baseline confirmed)');
  } else {
    record('no-session SIGTERM shutdown', false, `No shutdown event or wrong reason. Events: ${JSON.stringify(result.events.map(e => e.type))}`);
  }
}

async function main() {
  log('Starting session recovery bug condition exploration tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: Tests 1-3 FAIL on unfixed code, Test 4 PASS\n');

  await testFifoInAbsorptionPath();
  await testFifoFallbackCreatedFlag();
  await testReasonFieldInControlChannel();
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
