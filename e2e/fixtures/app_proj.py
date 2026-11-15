import json
import os
import sys


def main() -> int:
    proj_dir = os.path.dirname(os.path.abspath(__file__))
    entries = sorted(os.listdir(proj_dir))
    arg = sys.argv[1] if len(sys.argv) > 1 else "default"
    cwd = os.getcwd()
    payload = {
        "arg": arg,
        "has_cwd": bool(cwd),
        "has_self": os.path.basename(__file__) in entries,
    }
    print(json.dumps(payload, sort_keys=True))
    sys.stderr.write(f"app_proj log: arg={arg}\n")
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
