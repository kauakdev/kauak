# Context meters for a remote floor: the part of context.ts that has
# to run where the agents' transcripts are. The bridge starts it over SSH
# (`python3 -c ...`, so nothing is installed on the remote machine) and keeps
# it running; it keeps its own caches between requests.
#
# Protocol, one JSON object per line:
#   in:  {"id": 1, "panes": [{"pane_id", "agent", "session": {"kind", "value"} | null, "pids": [...], "cwd"}]}
#   out: {"id": 1, "result": {pane_id: {"usage": {"used", "max"} | null, "pid": int | null}}}
# `session` is Herdr's pane.agent_session; `pids` are the pane's foreground
# processes (pane.process_info), for a pane without a session. `pid` in the
# answer is the agent's: Claude Code's, or the first Codex process.
#
# Keep the reading rules in step with context.ts.

import datetime
import json
import os
import re
import subprocess
import sys
import time

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
CODEX_DIR = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
MISS_S = 15
FIRST_READ_MAX = 32 * 1024 * 1024
CLAUDE_WINDOW = 1_000_000
CLAUDE_WINDOW_SMALL = 200_000
CLAUDE_SMALL_MODEL = re.compile(r"^claude-(?:3|haiku)|^claude-(?:opus|sonnet)-4(?:-[015])?(?:-\d{8})?$")
SESSION_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")

found = {}        # "kind:id" -> transcript path
misses = {}       # "kind:id" -> when to look again
transcripts = {}  # path -> Transcript
rollouts = {}     # rollout path -> its session_meta: {cwd, originator, source}


class ClaudeLog:
    def __init__(self):
        self.used = None
        self.model = None    # the model of the last call
        self.model_id = None  # Claude Code's name for it, "[1m]" when it asked for 1M

    def wants(self, line):
        return b'"usage"' in line or b'"compact_boundary"' in line or b'"modelId"' in line

    def add(self, e):
        if e.get("isSidechain"):
            return
        kind = e.get("type")
        if kind == "assistant":
            m = e.get("message") or {}
            u = m.get("usage")
            if not u or m.get("model") == "<synthetic>":
                return
            used = (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0) + (u.get("cache_read_input_tokens") or 0)
            if used > 0:
                self.used = used
            if isinstance(m.get("model"), str):
                self.model = m["model"]
        elif kind == "system" and e.get("subtype") == "compact_boundary":
            post = (e.get("compactMetadata") or {}).get("postTokens")
            self.used = post if isinstance(post, int) else None
        elif kind == "attachment" and (e.get("attachment") or {}).get("type") == "model":
            self.model_id = ((e["attachment"].get("identity") or {}).get("modelId")) or self.model_id

    def usage(self):
        if self.used is None:
            return None
        small = (self.used <= CLAUDE_WINDOW_SMALL and "[1m]" not in (self.model_id or "").lower()
                 and CLAUDE_SMALL_MODEL.match(self.model or self.model_id or "") is not None)
        return {"used": self.used, "max": CLAUDE_WINDOW_SMALL if small else CLAUDE_WINDOW}


class CodexLog:
    def __init__(self):
        self.used = None
        self.max = None

    def wants(self, line):
        return b'"token_count"' in line

    def add(self, e):
        p = e.get("payload") or {}
        info = p.get("info") if e.get("type") == "event_msg" and p.get("type") == "token_count" else None
        if not info:
            return
        total = (info.get("last_token_usage") or {}).get("total_tokens")
        if isinstance(total, int):
            self.used = total
        if isinstance(info.get("model_context_window"), int):
            self.max = info["model_context_window"]

    def usage(self):
        return {"used": self.used, "max": self.max} if self.used is not None and self.max else None


class Transcript:
    """One transcript, read incrementally from where the last read stopped."""

    def __init__(self, path, kind):
        self.path = path
        self.log_class = ClaudeLog if kind == "claude" else CodexLog
        self.reset()

    def reset(self):
        self.log = self.log_class()
        self.offset = 0
        self.rest = b""
        self.skip_first = False

    def usage(self):
        size = os.stat(self.path).st_size
        if size < self.offset:  # rewritten: start over
            self.reset()
        if size > self.offset:
            self.read_to(size)
        return self.log.usage()

    def read_to(self, size):
        start = self.offset
        if start == 0 and size > FIRST_READ_MAX:
            start = size - FIRST_READ_MAX
            self.skip_first = True
        with open(self.path, "rb") as f:
            f.seek(start)
            left = size - start
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                left -= len(chunk)
                self.offset = size - left
                lines = (self.rest + chunk).split(b"\n")
                self.rest = lines.pop()
                for line in lines:
                    if self.skip_first:  # started mid-line
                        self.skip_first = False
                        continue
                    if self.log.wants(line):
                        try:
                            self.log.add(json.loads(line))
                        except Exception:
                            pass


def session_file(pid):
    """Claude Code's record of a running instance: ~/.claude/sessions/<pid>.json."""
    if not isinstance(pid, int):
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    try:
        with open(os.path.join(CLAUDE_DIR, "sessions", f"{pid}.json"), encoding="utf-8") as f:
            meta = json.load(f)
    except Exception:
        return None
    return meta if meta.get("pid") == pid and isinstance(meta.get("sessionId"), str) else None


def find_claude(sid, cwd):
    projects = os.path.join(CLAUDE_DIR, "projects")
    if cwd:
        guess = os.path.join(projects, re.sub(r"[^A-Za-z0-9]", "-", cwd), f"{sid}.jsonl")
        if os.path.exists(guess):
            return guess
    try:
        dirs = os.listdir(projects)
    except OSError:
        return None
    for d in dirs:
        path = os.path.join(projects, d, f"{sid}.jsonl")
        if os.path.exists(path):
            return path
    return None


def find_codex(sid):
    def ls(d):
        try:
            return sorted(os.listdir(d), reverse=True)
        except OSError:
            return []
    root = os.path.join(CODEX_DIR, "sessions")
    for y in ls(root):
        for m in ls(os.path.join(root, y)):
            for d in ls(os.path.join(root, y, m)):
                day = os.path.join(root, y, m, d)
                for name in ls(day):
                    if name.endswith(f"-{sid}.jsonl"):
                        return os.path.join(day, name)
    return None


def find(kind, sid, cwd=None):
    if not isinstance(sid, str) or not SESSION_ID.match(sid):
        return None
    key = f"{kind}:{sid}"
    known = found.get(key)
    if known and os.path.exists(known):
        return known
    if misses.get(key, 0) > time.time():
        return None
    path = find_claude(sid, cwd) if kind == "claude" else find_codex(sid)
    if path:
        found[key] = path
        misses.pop(key, None)
    else:
        misses[key] = time.time() + MISS_S
    return path


def process_start(pids):
    """The earliest-started of `pids` and when it started (s), from `ps`."""
    if not pids:
        return None
    try:
        out = subprocess.run(["ps", "-o", "pid=,lstart=", "-p", ",".join(str(p) for p in pids)],
                             capture_output=True, text=True, env={**os.environ, "LC_ALL": "C"}, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    best = None
    for line in out.splitlines():
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            at = time.mktime(time.strptime(" ".join(parts[1].split()), "%a %b %d %H:%M:%S %Y"))
        except ValueError:
            continue
        if best is None or at < best[1]:
            best = (int(parts[0]), at)
    return best


def rollout_meta(path):
    """A rollout's first line, session_meta; {} if it is something else, None while it is being written."""
    try:
        with open(path, "rb") as f:
            head = f.read(1 << 20)
    except OSError:
        return None
    nl = head.find(b"\n")
    if nl == -1:
        return None
    try:
        e = json.loads(head[:nl])
    except ValueError:
        return {}
    p = e.get("payload") if isinstance(e, dict) and e.get("type") == "session_meta" else None
    return {"cwd": p.get("cwd"), "originator": p.get("originator"), "source": p.get("source")} if isinstance(p, dict) else {}


def codex_by_folder(cwd, since):
    """The newest terminal Codex rollout for `cwd` written since `since` (when Codex started), from the day it started on."""
    best, best_time = None, 0
    day = datetime.date.fromtimestamp(since) - datetime.timedelta(days=1)  # time zones
    last = datetime.date.today() + datetime.timedelta(days=1)
    for _ in range(31):
        if day > last:
            break
        d = os.path.join(CODEX_DIR, "sessions", f"{day.year:04d}", f"{day.month:02d}", f"{day.day:02d}")
        day += datetime.timedelta(days=1)
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            if not (name.startswith("rollout-") and name.endswith(".jsonl")):
                continue
            path = os.path.join(d, name)
            try:
                mtime = os.stat(path).st_mtime
            except OSError:
                continue
            if mtime < since or mtime <= best_time:
                continue
            meta = rollouts.get(path)
            if meta is None:
                meta = rollout_meta(path)
                if meta is not None:
                    rollouts[path] = meta
            # A subagent's rollout has an object for `source`.
            if meta and meta.get("cwd") == cwd and meta.get("originator") == "codex-tui" and isinstance(meta.get("source"), str):
                best, best_time = path, mtime
    return best


def pane_usage(pane, used):
    agent, s, pid, path = pane.get("agent"), pane.get("session"), None, None
    if s and isinstance(s.get("value"), str):
        if s.get("kind") == "path":
            path = s["value"] if s["value"].endswith(".jsonl") else None
        elif s.get("kind") == "id":
            path = find(agent, s["value"], pane.get("cwd"))
    elif agent == "codex":
        # The pid is kept even before the first rollout shows up, so the next read looks again.
        started = process_start(pane.get("pids") or [])
        if started:
            pid = started[0]
            path = codex_by_folder(pane.get("cwd"), started[1])
    elif agent == "claude":
        for p in pane.get("pids") or []:
            meta = session_file(p)
            if meta:
                pid = p
                path = find("claude", meta["sessionId"], meta.get("cwd"))
                break
    usage = None
    if path:
        used.add(path)
        t = transcripts.get(path)
        if not t:
            t = transcripts[path] = Transcript(path, agent)
        try:
            usage = t.usage()
        except OSError:
            pass
    return {"usage": usage, "pid": pid}


def main():
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        used, result = set(), {}
        for pane in req.get("panes") or []:
            try:
                result[pane["pane_id"]] = pane_usage(pane, used)
            except Exception:
                pass
        for path in [p for p in transcripts if p not in used]:
            del transcripts[path]
        sys.stdout.write(json.dumps({"id": req.get("id"), "result": result}) + "\n")
        sys.stdout.flush()


main()
