#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TESTS=(
  "R1 (CPS Syscall ABI & Preemption)|test_r1_cps_preemption.mjs"
  "R2 (README & WASM ABI Docs)|test_r2_readme_abi.mjs"
  "R3 (Web UI & Python .tar.gz)|test_r3_web_ui_python.mjs"
  "R4 (Codebase Cleanliness)|test_r4_cleanliness.mjs"
)

FAILED=0

for entry in "${TESTS[@]}"; do
  LABEL="${entry%%|*}"
  FILE="${entry##*|}"
  echo "============================================================"
  echo "Running: ${LABEL} (${FILE})"
  echo "============================================================"
  if node "${SCRIPT_DIR}/${FILE}"; then
    echo ">>> RESULT: PASS - ${LABEL}"
  else
    echo ">>> RESULT: FAIL - ${LABEL}"
    FAILED=$((FAILED + 1))
  fi
  echo ""
done

echo "============================================================"
if [[ "${FAILED}" -eq 0 ]]; then
  echo "ALL PHASE 2 E2E TESTS PASSED (4/4)"
  exit 0
else
  echo "PHASE 2 E2E TESTS FAILED (${FAILED}/4 failed)"
  exit 1
fi
