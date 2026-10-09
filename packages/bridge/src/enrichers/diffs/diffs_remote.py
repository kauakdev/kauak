# Printers for a remote floor: what diffs.ts needs from the checkouts
# on that machine, which is git and the files themselves. The bridge starts it
# over SSH like context_remote.py (ssh/remote.ts); all the deciding (what
# changed, the diffs) stays in diffs.ts.
#
# Protocol, one JSON object per line (b64: base64 of the bytes):
#   in:  {"id", "op": "git", "cwd", "args": [...], "input": b64 | null, "max": int}
#   out: {"id", "result": {"ok": bool, "out": b64, "truncated": bool, "err": str}}
#   in:  {"id", "op": "stat", "root", "paths": [...]}
#   out: {"id", "result": {path: "size:mtime" | "other" | null}}
#   in:  {"id", "op": "read", "root", "paths": [...], "max": int}
#   out: {"id", "result": {path: b64 | "large" | null}}
# "other" is something that is not a regular file (a directory, a symlink);
# null, nothing there.

import base64
import json
import os
import stat
import subprocess
import sys

GIT_TIMEOUT_S = 15


def b64(data):
    return base64.b64encode(data).decode("ascii")


def run_git(req):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    data = base64.b64decode(req["input"]) if req.get("input") is not None else b""
    try:
        p = subprocess.run(["git", "-c", "core.quotepath=off"] + list(req["args"]), cwd=req["cwd"], env=env,
                           input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=GIT_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "out": "", "truncated": False, "err": str(e)}
    out, cap = p.stdout, int(req.get("max") or len(p.stdout))
    err = p.stderr.decode("utf-8", "replace").strip()
    return {"ok": p.returncode == 0, "out": b64(out[:cap]), "truncated": len(out) > cap, "err": err}


def stat_paths(req):
    result = {}
    for path in req["paths"]:
        try:
            st = os.lstat(os.path.join(req["root"], path))
        except OSError:
            result[path] = None
            continue
        result[path] = f"{st.st_size}:{st.st_mtime_ns}" if stat.S_ISREG(st.st_mode) else "other"
    return result


def read_paths(req):
    result, cap = {}, int(req["max"])
    for path in req["paths"]:
        try:
            with open(os.path.join(req["root"], path), "rb") as f:
                data = f.read(cap + 1)
        except OSError:
            result[path] = None
            continue
        result[path] = "large" if len(data) > cap else b64(data)
    return result


OPS = {"git": run_git, "stat": stat_paths, "read": read_paths}


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        try:
            result = OPS[req["op"]](req)
        except Exception:
            result = None
        sys.stdout.write(json.dumps({"id": req.get("id"), "result": result}) + "\n")
        sys.stdout.flush()


main()
