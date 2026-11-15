#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

TIER="${1:-all}"
case "${TIER}" in
  all)
    PATTERN="test_v2_*.py"
    ;;
  prebuild)
    PATTERN="test_v2_prebuild.py"
    ;;
  tier1|1)
    PATTERN="test_v2_tier1.py"
    ;;
  tier2|2)
    PATTERN="test_v2_tier2.py"
    ;;
  tier3|3)
    PATTERN="test_v2_tier3.py"
    ;;
  *)
    echo "Usage: $0 [all|prebuild|tier1|tier2|tier3]" >&2
    exit 2
    ;;
esac

echo "[run_e2e_v2] Running python3 -m unittest discover -s e2e_v2 -p \"${PATTERN}\" -v"
python3 -m unittest discover -s e2e_v2 -p "${PATTERN}" -v
