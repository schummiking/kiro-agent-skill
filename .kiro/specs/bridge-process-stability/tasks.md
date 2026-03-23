# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Bridge Process Stability (stdin EOF / signal / heartbeat)
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the three bug scenarios exist
  - **Scoped PBT Approach**: Scope the property to concrete failing cases for each bug condition:
    - `isBugCondition({ event: 'stdin_eof' })` → stdin EOF causes process exit (expect process to stay alive)
    - `isBugCondition({ event: 'signal', signal: 'SIGTERM' })` → SIGTERM kills without cleanup (expect graceful shutdown)
    - `isBugCondition({ event: 'signal', signal: 'SIGINT' })` → SIGINT kills without cleanup (expect graceful shutdown)
    - `isBugCondition({ event: 'idle_period', duration: 60000 })` → no heartbeat output (expect heartbeat events)
  - Write a Node.js test script (`tests/test-bug-condition-exploration.js`) that:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process
    - Test 1 (stdin EOF): Closes stdin immediately, waits 3 seconds, asserts process is still running → WILL FAIL (process exits)
    - Test 2 (SIGTERM): Sends SIGTERM, checks stdout for `shutdown` event → WILL FAIL (no shutdown event, process dies)
    - Test 3 (SIGINT): Sends SIGINT, checks stdout for `shutdown` event → WILL FAIL (no shutdown event, process dies)
    - Test 4 (heartbeat): Waits 35 seconds, checks stdout for `heartbeat` event → WILL FAIL (no heartbeat output)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL (this is correct - it proves the bugs exist)
  - Document counterexamples found:
    - stdin EOF → process exits with code 0 immediately
    - SIGTERM → process exits with code null/signal SIGTERM, no shutdown event emitted
    - SIGINT → process exits with code null/signal SIGINT, no shutdown event emitted
    - 35 seconds idle → no heartbeat event in stdout
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - JSONL Command Response and ACP Exit Handling
  - **IMPORTANT**: Follow observation-first methodology
  - Write a Node.js test script (`tests/test-preservation-properties.js`) that:
    - Spawns `scripts/kiro-acp-bridge.js` as a child process with stdin pipe
    - Observe: `{"op":"ping"}` → returns `{"type":"pong","pid":null,"ready":false,"session":...,"initializeResult":null,"sessions":...}`
    - Observe: `{"op":"stop"}` → returns `{"type":"stop_requested","session":...,"pid":null}`
    - Observe: `{"op":"unknown_op"}` → returns `{"type":"bridge_error","message":"Unknown op: unknown_op"}`
    - Observe: invalid JSON `not json` → returns `{"type":"bridge_error","message":"Invalid JSON input"}`
    - Observe: `{"op":"send"}` without session → returns `{"type":"bridge_error","op":"send","message":"No session id"}`
    - Observe: empty line → no response (ignored)
  - Write property-based tests asserting:
    - For all valid ping commands: response type is "pong" with fields pid, ready, session, initializeResult, sessions
    - For all stop commands (without ACP running): response type is "stop_requested" with session and pid fields
    - For all unknown op commands: response type is "bridge_error" with message containing the op name
    - For all invalid JSON inputs: response type is "bridge_error" with message "Invalid JSON input"
    - For all send/reply without session: response type is "bridge_error" with message "No session id"
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 3. Fix for bridge process stability (stdin EOF / signal handling / heartbeat)

  - [x] 3.1 Add keepalive timer with heartbeat output
    - Add `HEARTBEAT_INTERVAL_MS = 30_000` constant and `startTime = Date.now()` at module level
    - Create `setInterval` that emits `{"type":"heartbeat","pid":process.pid,"uptime":...,"session":...,"ready":...}` every 30 seconds
    - Timer MUST remain in ref state (do NOT call `.unref()`) to keep event loop alive after stdin EOF
    - Place timer creation before `loadState()` call
    - _Bug_Condition: isBugCondition({ event: 'stdin_eof' }) — keepalive timer prevents process exit when readline closes_
    - _Bug_Condition: isBugCondition({ event: 'idle_period', duration > 30000 }) — heartbeat output lets host detect liveness_
    - _Expected_Behavior: process stays running after stdin EOF; heartbeat events emitted every 30s_
    - _Preservation: Timer must not interfere with existing JSONL command processing or ACP communication_
    - _Requirements: 1.1, 1.4, 2.1, 2.4_

  - [x] 3.2 Handle readline close event (stdin EOF)
    - Register `rl.on('close', ...)` handler after `rl` creation
    - Handler emits `{"type":"info","message":"stdin closed (EOF), bridge remains running via keepalive"}` only
    - Handler does NOT call `process.exit()` or trigger shutdown
    - Keepalive timer from 3.1 ensures event loop stays active
    - _Bug_Condition: isBugCondition({ event: 'stdin_eof' }) — readline close no longer causes process exit_
    - _Expected_Behavior: bridge emits info event and continues running_
    - _Preservation: No impact on existing rl.on('line') handler_
    - _Requirements: 1.1, 2.1_

  - [x] 3.3 Add gracefulShutdown function
    - Create `let shuttingDown = false` flag at module level
    - Create `async function gracefulShutdown(reason)` that:
      1. Checks `shuttingDown` flag, returns immediately if true (prevents duplicate shutdown)
      2. Sets `shuttingDown = true`
      3. Clears heartbeat timer via `clearInterval(heartbeatTimer)`
      4. Emits `{"type":"shutdown","reason":...,"session":...,"pid":...}`
      5. If ACP child is running: sends SIGTERM, waits up to 5 seconds for exit, then SIGKILL if still alive
      6. Calls `saveState()`
      7. Calls `notifyUser(...)` with shutdown reason
      8. Calls `process.exit(0)`
    - _Bug_Condition: isBugCondition({ event: 'signal', signal: 'SIGTERM'|'SIGINT' }) — provides cleanup path_
    - _Expected_Behavior: ACP child terminated, state saved, exit event emitted, user notified_
    - _Preservation: Does not affect existing stopBridge() or ACP exit handler behavior_
    - _Requirements: 1.2, 1.3, 2.2, 2.3_

  - [x] 3.4 Register SIGTERM and SIGINT signal handlers
    - Add `process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))` after rl creation
    - Add `process.on('SIGINT', () => gracefulShutdown('SIGINT'))` after rl creation
    - Both delegate to `gracefulShutdown()` from 3.3
    - _Bug_Condition: isBugCondition({ event: 'signal', signal: 'SIGTERM'|'SIGINT' })_
    - _Expected_Behavior: signals trigger graceful shutdown instead of immediate termination_
    - _Preservation: No impact on existing command handling or ACP communication_
    - _Requirements: 1.2, 1.3, 2.2, 2.3_

  - [x] 3.5 Modify stopBridge to clear heartbeat timer
    - Update `stopBridge()` to call `clearInterval(heartbeatTimer)` before existing logic
    - This allows process to exit naturally after ACP child exits (no keepalive timer holding event loop)
    - Keep existing `acp.kill('SIGTERM')` and `emit(stop_requested)` logic unchanged
    - _Bug_Condition: N/A — this is cleanup for the new timer_
    - _Expected_Behavior: stop command clears timer so process can exit after ACP exits_
    - _Preservation: stop command behavior (SIGTERM to ACP, stop_requested event) must remain identical_
    - _Requirements: 3.3_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Bridge Process Stability
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied:
      - stdin EOF → process stays running (keepalive timer active)
      - SIGTERM → graceful shutdown event emitted, ACP child terminated
      - SIGINT → graceful shutdown event emitted, ACP child terminated
      - 35 seconds idle → heartbeat events appear in stdout
    - Run `tests/test-bug-condition-exploration.js`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bugs are fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - JSONL Command Response and ACP Exit Handling
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run `tests/test-preservation-properties.js`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all JSONL command responses are identical to pre-fix baseline
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all test files: `test-bug-condition-exploration.js` and `test-preservation-properties.js`
  - Ensure all tests pass, ask the user if questions arise
  - Verify no regressions in existing bridge functionality
