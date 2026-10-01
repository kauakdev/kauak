# Context meters for a remote floor: the part of bridge/context.js that has
# to run where the agents' transcripts are. The bridge starts it over SSH
# (`python3 -c ...`, so nothing is installed on the remote machine) and keeps
# it running; it keeps its own caches between requests.
#
# Protocol, one JSON object per line:
#   in:  {"id": 1, "panes": [{"pane_id", "agent", "session": {"kind", "value"} | null, "pids": [...], "cwd"}]}
#   out: {"id": 1, "result": {pane_id: {"usage": {"used", "max"} | null, "pid": int | null}}}
# `session` is Herdr's pane.agent_session; `pids` are the pane's foreground
# processes (pane.process_info), for a Claude Code pane without a session.
# `pid` in the answer is the one that turned out to be Claude Code's.
#
# Keep the reading rules in step with context.js.

import json
import os
import re
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


def pane_usage(pane, used):
    agent, s, pid, path = pane.get("agent"), pane.get("session"), None, None
    if s and isinstance(s.get("value"), str):
        if s.get("kind") == "path":
            path = s["value"] if s["value"].endswith(".jsonl") else None
        elif s.get("kind") == "id":
            path = find(agent, s["value"], pane.get("cwd"))
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
