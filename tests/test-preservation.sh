#!/usr/bin/env bash
# Preservation Property Test — Property 2: Preservation
# Validates: Requirements 3.1, 3.2, 3.3, 3.4
#
# This test verifies that existing paths and behaviors remain available.
# On UNFIXED code: this test should PASS (establishing the baseline).
# On FIXED code: this test should still PASS (confirming no regression).
#
# What we verify:
#   1. sessions_spawn ACP path still exists in SKILL.md (check for `kiro-cli acp`)
#   2. Session continuity check's existing paths exist (`process action:list` and `kiro-cli chat --list-sessions`)
#   3. references/delegation-modes.md is not modified (checksum)
#   4. references/notification-contract.md is not modified (checksum)
#
# NOTE: CLI non-interactive path was INTENTIONALLY removed — not checked for preservation.

set -euo pipefail

SKILL_FILE="SKILL.md"
DELEGATION_FILE="references/delegation-modes.md"
NOTIFICATION_FILE="references/notification-contract.md"
CHECKSUM_FILE="tests/preservation-checksums.txt"
FAILURES=0
TOTAL=0

pass() {
  echo "  ✅ PASS: $1"
}

fail() {
  echo "  ❌ FAIL: $1"
  echo "    Detail: $2"
  FAILURES=$((FAILURES + 1))
}

echo "=== Preservation Property Test ==="
echo "Testing: $SKILL_FILE, $DELEGATION_FILE, $NOTIFICATION_FILE"
echo ""

# ---------------------------------------------------------------------------
# Check 1: sessions_spawn ACP path still exists in SKILL.md
# The path can change role (from "preferred" to "optional alternative"),
# but the path itself (`kiro-cli acp` in transport routing) cannot be deleted.
# Requirement: 3.1
# ---------------------------------------------------------------------------
echo "--- Check 1: sessions_spawn ACP path exists ---"
TOTAL=$((TOTAL + 1))

if grep -q "kiro-cli acp" "$SKILL_FILE"; then
  pass "sessions_spawn ACP path exists (found 'kiro-cli acp' in transport routing)"
else
  fail "sessions_spawn ACP path is MISSING" \
       "'kiro-cli acp' not found in $SKILL_FILE — this path must not be deleted"
fi

# ---------------------------------------------------------------------------
# Check 2: Session continuity check's existing paths are not deleted
# Must find both `process action:list` and `kiro-cli chat --list-sessions`
# in the decision tree.
# Requirement: 3.2
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 2: Session continuity check — existing paths preserved ---"

TOTAL=$((TOTAL + 1))
if grep -q "process action:list" "$SKILL_FILE"; then
  pass "Session continuity path 1 exists (found 'process action:list')"
else
  fail "Session continuity path 1 is MISSING" \
       "'process action:list' not found in $SKILL_FILE — this check step must not be deleted"
fi

TOTAL=$((TOTAL + 1))
if grep -q "kiro-cli chat --list-sessions" "$SKILL_FILE"; then
  pass "Session continuity path 2 exists (found 'kiro-cli chat --list-sessions')"
else
  fail "Session continuity path 2 is MISSING" \
       "'kiro-cli chat --list-sessions' not found in $SKILL_FILE — this check step must not be deleted"
fi

# ---------------------------------------------------------------------------
# Check 3 & 4: Reference files not modified (checksum verification)
# Requirement: 3.3, 3.4
# ---------------------------------------------------------------------------
echo ""
echo "--- Check 3 & 4: Reference files unchanged (checksum) ---"

# Compute current checksums
DELEGATION_CHECKSUM=$(md5sum "$DELEGATION_FILE" | awk '{print $1}')
NOTIFICATION_CHECKSUM=$(md5sum "$NOTIFICATION_FILE" | awk '{print $1}')

if [ -f "$CHECKSUM_FILE" ]; then
  # Compare against stored checksums
  STORED_DELEGATION=$(grep "^delegation-modes:" "$CHECKSUM_FILE" | cut -d: -f2)
  STORED_NOTIFICATION=$(grep "^notification-contract:" "$CHECKSUM_FILE" | cut -d: -f2)

  TOTAL=$((TOTAL + 1))
  if [ "$DELEGATION_CHECKSUM" = "$STORED_DELEGATION" ]; then
    pass "delegation-modes.md unchanged (checksum: $DELEGATION_CHECKSUM)"
  else
    fail "delegation-modes.md has been MODIFIED" \
         "Expected checksum $STORED_DELEGATION, got $DELEGATION_CHECKSUM"
  fi

  TOTAL=$((TOTAL + 1))
  if [ "$NOTIFICATION_CHECKSUM" = "$STORED_NOTIFICATION" ]; then
    pass "notification-contract.md unchanged (checksum: $NOTIFICATION_CHECKSUM)"
  else
    fail "notification-contract.md has been MODIFIED" \
         "Expected checksum $STORED_NOTIFICATION, got $NOTIFICATION_CHECKSUM"
  fi
else
  # First run — store checksums as baseline
  echo "delegation-modes:$DELEGATION_CHECKSUM" > "$CHECKSUM_FILE"
  echo "notification-contract:$NOTIFICATION_CHECKSUM" >> "$CHECKSUM_FILE"

  TOTAL=$((TOTAL + 1))
  pass "delegation-modes.md baseline checksum stored ($DELEGATION_CHECKSUM)"

  TOTAL=$((TOTAL + 1))
  pass "notification-contract.md baseline checksum stored ($NOTIFICATION_CHECKSUM)"

  echo ""
  echo "  📝 Baseline checksums saved to $CHECKSUM_FILE"
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
  echo "❌ PRESERVATION TEST FAILED — $FAILURES preservation check(s) broken"
  exit 1
else
  echo "✅ PRESERVATION TEST PASSED — All existing paths and behaviors preserved"
  exit 0
fi
