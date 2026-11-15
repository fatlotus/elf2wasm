import json
import math
import statistics
import sys


def main() -> int:
    payload = json.loads(sys.argv[1])
    values = [float(x) for x in payload["values"]]
    mean = statistics.mean(values)
    stdev = statistics.stdev(values) if len(values) > 1 else 0.0
    result = {
        "count": len(values),
        "mean": round(mean, 6),
        "sqrt_mean": round(math.sqrt(abs(mean)), 6),
        "stdev": round(stdev, 6),
        "sum": round(sum(values), 6),
    }
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
