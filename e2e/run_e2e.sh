#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "[run_e2e] Building elf2wasm (cargo build --offline)..."
cargo build --offline

TIER="${1:-all}"
case "${TIER}" in
  all)
    PATTERN="test_tier*.py"
    ;;
  tier1|1)
    PATTERN="test_tier1.py"
    ;;
  tier2|2)
    PATTERN="test_tier2.py"
    ;;
  tier3|3)
    PATTERN="test_tier3.py"
    ;;
  tier4|4)
    PATTERN="test_tier4.py"
    ;;
  *)
    echo "Usage: $0 [all|tier1|tier2|tier3|tier4]" >&2
    exit 2
    ;;
esac

echo "[run_e2e] Running python3 -m unittest discover -s e2e -p \"${PATTERN}\" -v"
python3 -m unittest discover -s e2e -p "${PATTERN}" -v
