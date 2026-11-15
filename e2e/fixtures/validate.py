import json
import sys


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write(json.dumps({"error": "missing_argument", "code": 2}) + "\n")
        return 2

    raw = sys.argv[1]
    try:
        val = int(raw)
    except ValueError:
        sys.stderr.write(json.dumps({"error": "not_an_integer", "input": raw, "code": 2}) + "\n")
        return 2

    if val <= 0:
        sys.stderr.write(json.dumps({"error": "must_be_positive", "value": val, "code": 2}) + "\n")
        return 2

    print(json.dumps({"status": "valid", "value": val}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
