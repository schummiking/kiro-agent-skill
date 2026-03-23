#!/usr/bin/env node

/**
 * ACP Signal Isolation — Bug Condition Exploration Tests
 *
 * Verifies that the signal isolation bugs EXIST on unfixed code.
 * These tests encode the EXPECTED behavior — they will FAIL on unfixed code
 * (confirming the bugs exist) and PASS after the fix is applied.
 *
 * Bug conditions tested:
 * 1. bridge_signal_received event missing on SIGTERM
 * 2. terminatedBy field missing from exit event
 * 3. grace period pendingCalls field missing
 * 4. Full bridge_signal_received event format validation
 *
 * EXPECTED on UNFIXED code: All tests FAIL
 * EXPECTED on FIXED code: All tests PASS
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const BRIDGE_PATH = path.join(__dirname, '..', 'scripts', 'kiro-acp-bridge.js');
const TIMEOUT_MS = 8000;

const results = [];

function log(msg) {
  console.log(`[signal-bug-condition] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  const status = passed ? 'PASS' : 'FAIL';
  log(`${status}: ${name} — ${detail}`);
}

/**
 * Helper: spawn bridge, optionally send commands, then send SIGTERM,
 * collect all stdout events until exit or timeout.
 */
function spawnAndSignal(commands = [], delayBeforeSignal = 500, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let resolved = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    // Send commands sequentially
    let cmdIndex = 0;
    function sendNext() {
      if (cmdIndex < commands.length) {
        child.stdin.write(commands[cmdIndex] + '\n');
        cmdIndex++;
        setTimeout(sendNext, 200);
      } else {
        // All commands sent, wait then send SIGTERM
        setTimeout(() => {
          child.kill('SIGTERM');
        }, delayBeforeSignal);
      }
    }
    sendNext();

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

/**
 * Test 1: bridge_signal_received event on SIGTERM
 *
 * Bug: unfixed code does NOT emit bridge_signal_received event.
 * Expected after fix: bridge emits {"type":"bridge_signal_received","signal":"SIGTERM",...}
 *
 * isBugCondition({ scenario: 'no_bridge_signal_received' })
 */
async function testBridgeSignalReceivedEvent() {
  log('--- Test 1: bridge_signal_received event on SIGTERM ---');
  const events = await spawnAndSignal([], 500);

  const signalEvent = events.find((e) => e.type === 'bridge_signal_received');

  if (!signalEvent) {
    record('bridge_signal_received event', false,
      `No bridge_signal_received event found. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }

  const checks = [];
  if (signalEvent.signal !== 'SIGTERM') checks.push(`signal="${signalEvent.signal}" (expected "SIGTERM")`);
  if (typeof signalEvent.pendingCalls !== 'number') checks.push('missing or non-number pendingCalls');
  if (!signalEvent.timestamp) checks.push('missing timestamp');

  if (checks.length === 0) {
    record('bridge_signal_received event', true,
      `signal=SIGTERM, pendingCalls=${signalEvent.pendingCalls}, timestamp=${signalEvent.timestamp}`);
  } else {
    record('bridge_signal_received event', false, checks.join('; '));
  }
}

/**
 * Test 2: terminatedBy field in exit event handler (static code check)
 *
 * Bug: unfixed code exit event has only code and signal, no terminatedBy.
 * Expected after fix: exit handler computes and emits terminatedBy field.
 *
 * Since we can't start a real ACP (no kiro-cli), we verify the bridge source
 * contains the terminatedBy logic in the exit handler.
 *
 * isBugCondition({ scenario: 'no_terminatedBy' })
 */
async function testTerminatedByField() {
  log('--- Test 2: terminatedBy field in exit handler (code check) ---');

  const bridgeSrc = require('node:fs').readFileSync(BRIDGE_PATH, 'utf8');

  const checks = [];

  // Check that exit handler emits terminatedBy
  if (!bridgeSrc.includes('terminatedBy')) {
    checks.push('bridge source missing "terminatedBy" variable/field');
  }

  // Check the three-way classification logic
  if (!bridgeSrc.includes("'bridge'") && !bridgeSrc.includes('"bridge"')) {
    checks.push('missing "bridge" terminatedBy value');
  }
  if (!bridgeSrc.includes("'external'") && !bridgeSrc.includes('"external"')) {
    checks.push('missing "external" terminatedBy value');
  }
  if (!bridgeSrc.includes("'self'") && !bridgeSrc.includes('"self"')) {
    checks.push('missing "self" terminatedBy value');
  }

  // Check bridgeInitiatedKill state variable
  if (!bridgeSrc.includes('bridgeInitiatedKill')) {
    checks.push('missing bridgeInitiatedKill state variable');
  }

  // Check that emit includes terminatedBy in exit event
  if (!bridgeSrc.includes('type: \'exit\'') && !bridgeSrc.includes("type: 'exit'")) {
    // Try alternate patterns
    if (!bridgeSrc.includes("type: 'exit'")) {
      checks.push('cannot find exit event emission');
    }
  }

  if (checks.length === 0) {
    record('terminatedBy field', true,
      'bridge source contains terminatedBy logic with bridge/external/self classification');
  } else {
    record('terminatedBy field', false, checks.join('; '));
  }
}

/**
 * Test 3: grace period — pendingCalls field in bridge_signal_received
 *
 * Bug: unfixed code has no bridge_signal_received event, hence no pendingCalls info.
 * Expected after fix: bridge_signal_received includes pendingCalls count.
 *
 * isBugCondition({ scenario: 'no_grace_period', pendingCount: 1 })
 */
async function testGracePeriodPendingCalls() {
  log('--- Test 3: grace period pendingCalls ---');
  const events = await spawnAndSignal([], 500);

  const signalEvent = events.find((e) => e.type === 'bridge_signal_received');

  if (!signalEvent) {
    record('grace period pendingCalls', false,
      `No bridge_signal_received event. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }

  if (typeof signalEvent.pendingCalls !== 'number') {
    record('grace period pendingCalls', false,
      `pendingCalls is not a number: ${JSON.stringify(signalEvent.pendingCalls)}`);
    return;
  }

  record('grace period pendingCalls', true,
    `pendingCalls=${signalEvent.pendingCalls} (number field present)`);
}

/**
 * Test 4: Full bridge_signal_received event format
 *
 * Bug: unfixed code does not emit this event at all.
 * Expected after fix: {"type":"bridge_signal_received","signal":"SIGTERM","pendingCalls":<n>,"timestamp":"<ISO>"}
 *
 * isBugCondition({ scenario: 'no_bridge_signal_received' })
 */
async function testFullEventFormat() {
  log('--- Test 4: full bridge_signal_received event format ---');
  const events = await spawnAndSignal([], 500);

  const signalEvent = events.find((e) => e.type === 'bridge_signal_received');

  if (!signalEvent) {
    record('full event format', false,
      `No bridge_signal_received event. Events: ${JSON.stringify(events.map(e => e.type))}`);
    return;
  }

  const checks = [];

  // Required fields
  if (signalEvent.type !== 'bridge_signal_received') checks.push(`type mismatch`);
  if (signalEvent.signal !== 'SIGTERM') checks.push(`signal="${signalEvent.signal}"`);
  if (typeof signalEvent.pendingCalls !== 'number') checks.push('pendingCalls not a number');
  if (!signalEvent.timestamp || typeof signalEvent.timestamp !== 'string') {
    checks.push('timestamp missing or not string');
  } else {
    // Validate ISO format
    const d = new Date(signalEvent.timestamp);
    if (isNaN(d.getTime())) checks.push(`timestamp not valid ISO: "${signalEvent.timestamp}"`);
  }

  if (checks.length === 0) {
    record('full event format', true,
      `Complete: signal=SIGTERM, pendingCalls=${signalEvent.pendingCalls}, timestamp=${signalEvent.timestamp}`);
  } else {
    record('full event format', false, checks.join('; '));
  }
}

async function main() {
  log('Starting ACP signal isolation bug condition exploration tests');
  log(`Bridge: ${BRIDGE_PATH}`);
  log('EXPECTED: All tests FAIL on unfixed code (confirms bugs exist)\n');

  await testBridgeSignalReceivedEvent();
  await testTerminatedByField();
  await testGracePeriodPendingCalls();
  await testFullEventFormat();

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
