#!/usr/bin/env node

/**
 * Bridge Stdio Lifecycle — Bug Condition Exploration Tests
 *
 * Verifies that the bug conditions EXIST on unfixed documentation.
 * All 4 tests encode EXPECTED behavior (will FAIL on unfixed docs, PASS after fix).
 *
 * Bug conditions tested:
 * 1. SKILL.md launch command missing --control fifo
 * 2. SKILL.md uses process action:submit for sending control commands
 * 3. acp-bridge-protocol.md launch command missing --control fifo
 * 4. acp-bridge-protocol.md uses process action:submit for sending control commands
 */

const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.join(__dirname, '..', 'SKILL.md');
const PROTOCOL_PATH = path.join(__dirname, '..', 'references', 'acp-bridge-protocol.md');

const results = [];

function log(msg) {
  console.log(`[stdio-lifecycle-bug] ${msg}`);
}

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  log(`${passed ? 'PASS' : 'FAIL'}: ${name} — ${detail}`);
}

/**
 * Find the bridge launch command line(s) — the bash command that starts kiro-acp-bridge.js.
 * Only matches actual executable launch commands (containing setsid/node invocations),
 * not prose descriptions or table entries that merely reference the file.
 * Returns an array of matching lines.
 */
function findBridgeLaunchCommands(content) {
  const lines = content.split('\n');
  return lines.filter(line => {
    if (!line.includes('kiro-acp-bridge.js')) return false;
    if (line.trimStart().startsWith('#')) return false;
    // Must be an actual launch command: contains 'setsid' or 'node' as part of a command invocation
    return line.includes('setsid') && line.includes('node');
  });
}

/**
 * Find lines that use process action:submit with input: (sending a command to the bridge).
 * Excludes comment lines. Returns an array of matching lines.
 */
function findProcessSubmitCommandLines(content) {
  const lines = content.split('\n');
  return lines.filter(line => {
    const trimmed = line.trim();
    // Skip markdown comments/headers that just describe the concept
    if (trimmed.startsWith('#')) return false;
    // Match lines that contain both "process action:submit" and "input:" — these are sending commands
    return trimmed.includes('process action:submit') && trimmed.includes('input:');
  });
}

/**
 * Test 1: SKILL.md launch command has --control fifo
 *
 * Validates: Requirements 1.1, 1.2
 * On unfixed docs: FAIL (no --control fifo)
 * On fixed docs: PASS
 */
function testSkillLaunchCommand() {
  log('--- Test 1: SKILL.md launch command has --control fifo ---');
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const launchLines = findBridgeLaunchCommands(content);

  if (launchLines.length === 0) {
    record('SKILL.md launch --control fifo', false, 'Could not find any bridge launch command in SKILL.md');
    return;
  }

  log(`  Found ${launchLines.length} launch command(s)`);
  const missing = launchLines.filter(line => !line.includes('--control fifo'));

  if (missing.length === 0) {
    record('SKILL.md launch --control fifo', true, `All ${launchLines.length} launch command(s) contain --control fifo`);
  } else {
    for (const line of missing) {
      log(`  Missing --control fifo: ${line.trim()}`);
    }
    record('SKILL.md launch --control fifo', false, `${missing.length} of ${launchLines.length} launch command(s) missing --control fifo`);
  }
}

/**
 * Test 2: SKILL.md does NOT use process action:submit for control commands
 *
 * Validates: Requirements 1.3, 1.4
 * On unfixed docs: FAIL (multiple process action:submit lines exist)
 * On fixed docs: PASS
 */
function testSkillNoProcessSubmit() {
  log('--- Test 2: SKILL.md does NOT use process action:submit for control commands ---');
  const content = fs.readFileSync(SKILL_PATH, 'utf8');
  const submitLines = findProcessSubmitCommandLines(content);

  if (submitLines.length === 0) {
    record('SKILL.md no process submit', true, 'No process action:submit lines found for sending control commands');
  } else {
    for (const line of submitLines) {
      log(`  Found submit line: ${line.trim()}`);
    }
    record('SKILL.md no process submit', false, `Found ${submitLines.length} process action:submit line(s) sending control commands`);
  }
}

/**
 * Test 3: acp-bridge-protocol.md launch command has --control fifo
 *
 * Validates: Requirements 1.1, 1.2
 * On unfixed docs: FAIL (no --control fifo)
 * On fixed docs: PASS
 */
function testProtocolLaunchCommand() {
  log('--- Test 3: acp-bridge-protocol.md launch command has --control fifo ---');
  const content = fs.readFileSync(PROTOCOL_PATH, 'utf8');
  const launchLines = findBridgeLaunchCommands(content);

  if (launchLines.length === 0) {
    record('protocol launch --control fifo', false, 'Could not find any bridge launch command in acp-bridge-protocol.md');
    return;
  }

  log(`  Found ${launchLines.length} launch command(s)`);
  const missing = launchLines.filter(line => !line.includes('--control fifo'));

  if (missing.length === 0) {
    record('protocol launch --control fifo', true, `All ${launchLines.length} launch command(s) contain --control fifo`);
  } else {
    for (const line of missing) {
      log(`  Missing --control fifo: ${line.trim()}`);
    }
    record('protocol launch --control fifo', false, `${missing.length} of ${launchLines.length} launch command(s) missing --control fifo`);
  }
}

/**
 * Test 4: acp-bridge-protocol.md does NOT use process action:submit for control commands
 *
 * Validates: Requirements 1.3, 1.4
 * On unfixed docs: FAIL (multiple process action:submit lines exist)
 * On fixed docs: PASS
 */
function testProtocolNoProcessSubmit() {
  log('--- Test 4: acp-bridge-protocol.md does NOT use process action:submit for control commands ---');
  const content = fs.readFileSync(PROTOCOL_PATH, 'utf8');
  const submitLines = findProcessSubmitCommandLines(content);

  if (submitLines.length === 0) {
    record('protocol no process submit', true, 'No process action:submit lines found for sending control commands');
  } else {
    for (const line of submitLines) {
      log(`  Found submit line: ${line.trim()}`);
    }
    record('protocol no process submit', false, `Found ${submitLines.length} process action:submit line(s) sending control commands`);
  }
}

function main() {
  log('Starting bridge stdio lifecycle bug condition exploration tests');
  log(`SKILL.md: ${SKILL_PATH}`);
  log(`Protocol: ${PROTOCOL_PATH}`);
  log('EXPECTED: All 4 tests FAIL on unfixed docs (confirming bug condition exists)\n');

  testSkillLaunchCommand();
  testSkillNoProcessSubmit();
  testProtocolLaunchCommand();
  testProtocolNoProcessSubmit();

  console.log('\n========== SUMMARY ==========');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✓' : '✗';
    console.log(`  ${icon} ${r.name}: ${r.passed ? 'PASS' : 'FAIL'} — ${r.detail}`);
    if (!r.passed) allPassed = false;
  }
  console.log('=============================\n');

  if (allPassed) {
    log('All bug condition tests PASSED — docs are FIXED.');
    process.exit(0);
  } else {
    log('Bug condition tests FAILED — bug conditions confirmed to exist (expected on unfixed docs).');
    process.exit(1);
  }
}

main();
