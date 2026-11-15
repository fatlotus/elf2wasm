import json
import os
import sys


def try_op(label: str, fn) -> dict:
    try:
        fn()
        return {"op": label, "blocked": False}
    except OSError as exc:
        return {"op": label, "blocked": True, "errno": exc.errno}


def main() -> int:
    tmp_canary = sys.argv[1] if len(sys.argv) > 1 else "/tmp/e2e_canary.txt"
    ro_canary = sys.argv[2] if len(sys.argv) > 2 else "/app/canary.txt"
    ro_existing = sys.argv[3] if len(sys.argv) > 3 else "/app/data.xml"

    results = [
        try_op("write_tmp", lambda: open(tmp_canary, "w").write("escaped")),
        try_op("write_vfs_ro", lambda: open(ro_canary, "w").write("escaped")),
        try_op("read_unmounted_host", lambda: open("/etc/hostname", "r").read()),
        try_op("remove_vfs_ro", lambda: os.remove(ro_existing)),
    ]
    print(json.dumps(results, sort_keys=True))
    all_blocked = all(r["blocked"] for r in results)
    return 0 if all_blocked else 1


if __name__ == "__main__":
    raise SystemExit(main())
