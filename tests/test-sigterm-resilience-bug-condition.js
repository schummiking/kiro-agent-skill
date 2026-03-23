#!/usr/bin/env node

/**
 * Bridge SIGTERM Resilience — Bug Condition Exploration Tests
 *
 * Verifies that the SIGTERM absorption bugs EXIST on unfixed code.
 * Tests 1-3 encode EXPECTED behavior (will FAIL on unfixed, PASS after fix).
 * Test 4 confirms baseline behavior (will PASS on both).
 *
 * Bug conditions tested:
 * 1. gracefulShutdown() lacks sigTermCount absorption logic
 * 2. bridge_signal_received event lacks deferred field
 * 3. SKILL.md launch commands lack setsid
 * 4. (baseline) No-session SIGTERM still causes immediate shutdown
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const SKILL_PATH = path.join(__dirname, '..', 'SKILL.md');
const TIMEOUT_MS = 8000;

const results = [];

function log(msg) {
  console.log(`[sigterm-resilience-bug] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

/**
 * Test 1: Code check — gracefulShutdown has sigTermCount absorption logic
 */
async function testAbsorptionLogicExists() {
  log('--- Test 1: gracefulShutdown absorption logic ---');
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');

  const checks = [];
  if (!src.includes('sigTermCount')) checks.push('missing sigTermCount variable');
  if (!src.includes('firstSigTermTime')) checks.push('missing firstSigTermTime variable');
  if (!src.includes('sigTermTimeoutTimer')) checks.push('missing sigTermTimeoutTimer variable');

  if (checks.length === 0) {
    record('absorption logic', true, 'sigTermCount, firstSigTermTime, sigTermTimeoutTimer found');
  } else {
    record('absorption logic', false, checks.join('; '));
  }
}

/**
 * Test 2: Code check — bridge_signal_received event has deferred field
 */
async function testDeferredFieldExists() {
  log('--- Test 2: deferred field in bridge_signal_received ---');
  const src = fs.readFileSync(BRIDGE_PATH, 'utf8');

  if (src.includes('deferred')) {
    record('deferred field', true, 'deferred field found in bridge source');
  } else {
    record('deferred field', false, 'bridge source missing "deferred" field in bridge_signal_received event');
  }
}

/**
 * Test 3: Code check — SKILL.md launch commands include setsid
 */
async function testSetsidInSkill() {
  log('--- Test 3: setsid in SKILL.md ---');
  const src = fs.readFileSync(SKILL_PATH, 'utf8');

  // Check that at least one launch command includes setsid
  if (src.includes('setsid')) {
    record('setsid in SKILL.md', true, 'setsid found in SKILL.md launch commands');
  } else {
    record('setsid in SKILL.md', false, 'SKILL.md launch commands missing setsid');
  }
}

/**
 * Test 4: Behavioral — no-session SIGTERM causes immediate shutdown
 */
async function testNoSessionSigtermShutdown() {
  log('--- Test 4: no-session SIGTERM immediate shutdown ---');

  const exited = await new Promise((resolve) => {
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

  if (!exited.exited) {
    record('no-session SIGTERM shutdown', false, 'Bridge did not exit after SIGTERM');
    return;
  }

  const shutdown = exited.events.find(e => e.type === 'shutdown');
  if (shutdown && shutdown.reason === 'SIGTERM') {
    record('no-session SIGTERM shutdown', true, 'Bridge exited with shutdown event (baseline confirmed)');
  } else {
    record('no-session SIGTERM shutdown', false, `No shutdown event or wrong reason. Events: ${JSON.stringify(exited.events.map(e => e.type))}`);
  }
}

async function main() {
  log('Starting SIGTERM resilience bug condition exploration tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: Tests 1-3 FAIL on unfixed code, Test 4 PASS\n');

  await testAbsorptionLogicExists();
  await testDeferredFieldExists();
  await testSetsidInSkill();
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
