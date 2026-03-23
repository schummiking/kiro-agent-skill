#!/usr/bin/env bash
# Bug Condition Exploration Test — Property 1: Bug Condition
# Validates: Requirements 1.1-1.7, 2.1-2.8
#
# This test checks that SKILL.md satisfies all bug fix requirements:
#   - Bridge is MANDATORY (sole transport), no CLI fallback
#   - Hard prohibition on direct ACP spawn on Telegram
#   - Surface capability pre-check exists as mandatory first step
#   - Three ACP concepts explicitly distinguished
#   - one-shot-via-bridge workflow exists
#   - (surface × scenario) routing matrix exists (no CLI fallback row)
#   - Complete bridge session lifecycle workflow
#   - Session continuity check includes bridge path
#
# On UNFIXED code: this test should FAIL (confirming the bug exists).
# On FIXED code: this test should PASS (confirming the bug is resolved).

set -euo pipefail

SKILL_FILE="SKILL.md"
FAILURES=0
TOTAL=0

pass() {
  echo "  ✅ PASS: $1"
}

fail() {
  echo "  ❌ FAIL: $1"
  echo "    Counter-example: $2"
  FAILURES=$((FAILURES + 1))
}

echo "=== Bug Condition Exploration Test ==="
echo "Testing: $SKILL_FILE"
echo ""

# ---------------------------------------------------------------------------
# Check 1: CLI fallback should NOT exist — bridge is the ONLY transport
# Requirement: 1.1, 2.1
# ---------------------------------------------------------------------------
echo "--- Check 1: CLI fallback removed — bridge is sole transport ---"
TOTAL=$((TOTAL + 1))

if grep -qi "EMERGENCY.FALLBACK\|emergency fallback\|紧急回退" "$SKILL_FILE"; then
  fail "CLI fallback still exists (EMERGENCY FALLBACK found)" \
       "Transport routing table still contains EMERGENCY FALLBACK row — CLI should be completely removed"
else
  pass "CLI fallback removed — no EMERGENCY FALLBACK in transport routing"
fi

# ---------------------------------------------------------------------------
# Check 2: Bridge should be MANDATORY (not just DEFAULT)
# Requirement: 1.1, 2.1
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 2: Bridge is MANDATORY ---"
TOTAL=$((TOTAL + 1))

if grep -qi "MANDATORY.*all.scenarios\|MANDATORY.*transport\|MANDATORY.*bridge\|唯一传输" "$SKILL_FILE"; then
  pass "Bridge is labeled as MANDATORY"
else
  fail "Bridge is NOT labeled as MANDATORY" \
       "Transport routing uses DEFAULT instead of MANDATORY — constraint not hard enough"
fi

# ---------------------------------------------------------------------------
# Check 3: Hard prohibition on direct ACP spawn on Telegram
# Requirement: 1.2, 2.2
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 3: Hard prohibition on Telegram direct ACP spawn ---"
TOTAL=$((TOTAL + 1))

if grep -qi "PROHIBITED\|禁止.*direct.*ACP\|禁止.*sessions_spawn\|Do NOT attempt direct ACP" "$SKILL_FILE"; then
  pass "Hard prohibition exists for Telegram direct ACP spawn"
else
  fail "No hard prohibition for Telegram direct ACP spawn" \
       "Skill document uses soft recommendations instead of hard prohibitions"
fi

# ---------------------------------------------------------------------------
# Check 4: Surface capability pre-check exists
# Requirement: 1.4, 2.3
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 4: Surface capability pre-check ---"
TOTAL=$((TOTAL + 1))

if grep -qi "surface.capability.pre.check\|Surface.*pre.*check\|surface.*预检" "$SKILL_FILE"; then
  pass "Surface capability pre-check section exists"
else
  fail "Surface capability pre-check does NOT exist" \
       "No mandatory surface capability pre-check before transport selection"
fi

# ---------------------------------------------------------------------------
# Check 5: Three ACP concepts explicitly distinguished
# Requirement: 1.3, 2.4
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 5: Three ACP concepts split ---"
TOTAL=$((TOTAL + 1))

if grep -qi "Three ACP concepts\|三个 ACP 概念\|ACP protocol.*sessions_spawn.*bridge" "$SKILL_FILE"; then
  pass "Three ACP concepts section exists"
else
  fail "Three ACP concepts NOT explicitly distinguished" \
       "ACP protocol, direct ACP via sessions_spawn, and ACP bridge-as-process are not clearly separated"
fi

# ---------------------------------------------------------------------------
# Check 6: one-shot-via-bridge workflow should exist
# Requirement: 1.5, 2.5
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 6: one-shot-via-bridge workflow ---"
TOTAL=$((TOTAL + 1))

if grep -qi "one-shot-via-bridge\|one.shot.via.bridge" "$SKILL_FILE"; then
  pass "one-shot-via-bridge workflow is documented"
else
  fail "one-shot-via-bridge workflow does NOT exist" \
       "Searching 'one-shot-via-bridge' in SKILL.md → no match"
fi

# ---------------------------------------------------------------------------
# Check 7: (surface × scenario) routing matrix should exist
# Requirement: 1.7, 2.6
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 7: Routing matrix ---"
TOTAL=$((TOTAL + 1))

if grep -qi "routing.matrix\|路由矩阵\|surface.*scenario.*matrix\|surface.*×.*scenario" "$SKILL_FILE"; then
  pass "Routing matrix exists"
else
  fail "Routing matrix does NOT exist" \
       "Searching 'routing matrix' in SKILL.md → no match"
fi

# ---------------------------------------------------------------------------
# Check 8: Bridge session lifecycle workflow is complete
# Requirement: 1.5, 2.7
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 8: Bridge session lifecycle workflow ---"
TOTAL=$((TOTAL + 1))

BRIDGE_LIFECYCLE_HITS=$(grep -ci "session_new\|session_load\|prompt_completed\|bridge.*lifecycle\|bridge.*workflow\|会话生命周期" "$SKILL_FILE" || true)

if [ "$BRIDGE_LIFECYCLE_HITS" -ge 2 ]; then
  pass "Bridge session lifecycle workflow is documented ($BRIDGE_LIFECYCLE_HITS references)"
else
  fail "Bridge session lifecycle workflow is MISSING" \
       "Found only $BRIDGE_LIFECYCLE_HITS lifecycle references — need complete workflow"
fi

# ---------------------------------------------------------------------------
# Check 9: Session continuity check includes bridge path
# Requirement: 1.6, 2.8
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 9: Session continuity check — bridge path ---"
TOTAL=$((TOTAL + 1))

if grep -qi "kiro-acp-state\|bridge.*process\|bridge.*session.*check\|bridge.*continuity" "$SKILL_FILE"; then
  pass "Session continuity check includes bridge path"
else
  fail "Session continuity check does NOT include bridge path" \
       "No bridge path in session continuity check"
fi

# ---------------------------------------------------------------------------
# Check 10: Routing matrix does NOT have CLI fallback row
# Requirement: 2.1
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 10: Routing matrix has no CLI fallback row ---"
TOTAL=$((TOTAL + 1))

if grep -qiE "bridge.unavailable.*CLI|CLI.*fallback.*matrix|CLI non-interactive.*(emergency|fallback)" "$SKILL_FILE"; then
  fail "Routing matrix still contains CLI fallback row" \
       "Routing matrix should not have a 'bridge unavailable → CLI' row"
else
  pass "Routing matrix has no CLI fallback row"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Summary ==="
PASSED=$((TOTAL - FAILURES))
echo "Total checks: $TOTAL"
echo "Passed: $PASSED"
echo "Failed: $FAILURES"
echo ""

if [ "$FAILURES" -gt 0 ]; then
  echo "❌ TEST FAILED — $FAILURES bug condition(s) still present"
  exit 1
else
  echo "✅ TEST PASSED — All checks passed, bug condition resolved"
  exit 0
fi
