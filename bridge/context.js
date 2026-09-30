// Context meters: how full each agent's context window is. Neither Herdr nor
// the agents expose this over an API, but both Claude Code and Codex log the
// token count of every model call to a transcript file on disk, so the bridge
// reads those (floors on this machine only; a remote floor's files are out of
// reach) and adds `context: { used, max }` to the panes in the snapshots it
// sends out.
//
// Which transcript belongs to which pane:
// - Herdr's agent integrations (`herdr integration install claude`) report the
//   session on start: `pane.agent_session`, a transcript path or a session id.
// - Without it, a Claude Code pane is matched through its process: Claude
//   Code keeps ~/.claude/sessions/<pid>.json with the session id and folder of
//   each running instance (verified on 2.1.286; not a documented interface).
//
// Transcripts only grow, so each one is read incrementally from where the
// last read stopped.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const CODEX_DIR = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
const KINDS = new Set(["claude", "codex"]);
const POLL_MS = 2000;
// A snapshot often means the agent just wrote to its transcript (a status change).
const KICK_MS = 300;
// Where nothing matched, wait this long before searching again (process_info is a Herdr round trip).
const MISS_MS = 15_000;
// The first read of a long transcript starts this far from its end. The model
// line near the start may be skipped, and then the window size is a guess.
const FIRST_READ_MAX = 32 * 1024 * 1024;
// Claude Code's default window; "[1m]" model ids have a million tokens.
const CLAUDE_WINDOW = 200_000;
const CLAUDE_WINDOW_1M = 1_000_000;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

/** Emits "change" when any pane's context use changes. */
export class ContextTracker extends EventEmitter {
  /** `machine` must be on this computer: its panes' transcripts are read from disk. */
  constructor(machine) {
    super();
    this.m = machine;
    /** pane_id → { used, max } */
    this.usage = new Map();
    /** transcript path → Transcript */
    this.transcripts = new Map();
    /** pane_id → pid of its Claude Code process */
    this.pids = new Map();
    /** pane_id, or kind:session id → when to look again */
    this.misses = new Map();
    /** kind:session id → transcript path */
    this.found = new Map();
    this.running = false;
    this.again = false;
    this.kickTimer = null;
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.timer.unref();
    machine.on("snapshot", () => this.kick());
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.kickTimer);
  }

  /** The snapshot with `context` on every pane whose use is known. */
  annotate(snapshot) {
    if (!snapshot || this.usage.size === 0) return snapshot;
    return { ...snapshot, panes: snapshot.panes.map((p) => (this.usage.has(p.pane_id) ? { ...p, context: this.usage.get(p.pane_id) } : p)) };
  }

  kick() {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => { this.kickTimer = null; this.refresh(); }, KICK_MS);
  }

  async refresh() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.update();
      } while (this.again);
    } catch (err) {
      console.error(`[bridge] ${this.m.label}: context meters:`, err.message);
    } finally {
      this.running = false;
    }
  }

  async update() {
    const snap = this.m.snapshot;
    if (!snap || this.m.state !== "live") return;
    const next = new Map();
    const read = new Set();
    for (const pane of snap.panes) {
      if (!KINDS.has(pane.agent)) continue;
      const file = await this.transcriptOf(pane).catch(() => null);
      if (!file) continue;
      read.add(file);
      let t = this.transcripts.get(file);
      if (!t) this.transcripts.set(file, (t = new Transcript(file, pane.agent)));
      const usage = await t.usage().catch(() => null);
      if (usage) next.set(pane.pane_id, usage);
    }
    for (const file of [...this.transcripts.keys()]) if (!read.has(file)) this.transcripts.delete(file);
    const live = new Set(snap.panes.map((p) => p.pane_id));
    for (const id of [...this.pids.keys()]) if (!live.has(id)) this.pids.delete(id);
    if (sameUsage(next, this.usage)) return;
    this.usage = next;
    this.emit("change");
  }

  // ------------------------------------------------------------ which transcript

  async transcriptOf(pane) {
    // Herdr 0.9.1 shows the id even when the hook reported the path too.
    const s = pane.agent_session;
    if (s && s.agent === pane.agent && typeof s.value === "string") {
      if (s.kind === "path") return s.value.endsWith(".jsonl") ? s.value : null;
      if (s.kind === "id") return this.find(pane.agent, s.value, pane.cwd);
    }
    return pane.agent === "claude" ? this.claudeByProcess(pane.pane_id) : null;
  }

  /** The Claude Code session running in a pane, through ~/.claude/sessions/<pid>.json. */
  async claudeByProcess(paneId) {
    let pid = this.pids.get(paneId);
    let meta = pid ? await readSessionFile(pid) : null;
    if (!meta) {
      this.pids.delete(paneId);
      if ((this.misses.get(paneId) ?? 0) > Date.now()) return null;
      const res = await this.m.request("pane.process_info", { pane_id: paneId });
      for (const proc of res.process_info?.foreground_processes ?? []) {
        if ((meta = await readSessionFile(proc.pid))) { pid = proc.pid; break; }
      }
      if (!meta) { this.misses.set(paneId, Date.now() + MISS_MS); return null; }
      this.misses.delete(paneId);
      this.pids.set(paneId, pid);
    }
    return this.find("claude", meta.sessionId, meta.cwd);
  }

  /** A session id's transcript. Remembered once found; a miss is retried after a while (the file shows up with the first message). */
  async find(kind, id, cwd = null) {
    if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
    const key = `${kind}:${id}`;
    const known = this.found.get(key);
    if (known && fs.existsSync(known)) return known;
    if ((this.misses.get(key) ?? 0) > Date.now()) return null;
    const file = kind === "claude" ? await findClaudeTranscript(id, cwd) : await findCodexRollout(id);
    if (file) { this.found.set(key, file); this.misses.delete(key); }
    else this.misses.set(key, Date.now() + MISS_MS);
    return file;
  }
}

async function readSessionFile(pid) {
  if (!Number.isInteger(pid) || !alive(pid)) return null;
  try {
    const meta = JSON.parse(await fs.promises.readFile(path.join(CLAUDE_DIR, "sessions", `${pid}.json`), "utf8"));
    return meta.pid === pid && typeof meta.sessionId === "string" ? meta : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

/** ~/.claude/projects/<folder, non-alphanumerics as "-">/<id>.jsonl; any project folder if that is not it. */
async function findClaudeTranscript(id, cwd) {
  const projects = path.join(CLAUDE_DIR, "projects");
  if (cwd) {
    const guess = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
    if (fs.existsSync(guess)) return guess;
  }
  for (const dir of await fs.promises.readdir(projects).catch(() => [])) {
    const file = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, newest days first. */
async function findCodexRollout(id) {
  const ls = async (dir) => (await fs.promises.readdir(dir).catch(() => [])).sort().reverse();
  const root = path.join(CODEX_DIR, "sessions");
  for (const y of await ls(root)) for (const m of await ls(path.join(root, y))) for (const d of await ls(path.join(root, y, m))) {
    const dir = path.join(root, y, m, d);
    const name = (await ls(dir)).find((f) => f.endsWith(`-${id}.jsonl`));
    if (name) return path.join(dir, name);
  }
  return null;
}

function sameUsage(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, u] of a) {
    const v = b.get(id);
    if (!v || v.used !== u.used || v.max !== u.max) return false;
  }
  return true;
}

// ---------------------------------------------------------------- transcripts

/** One transcript, read incrementally; `usage()` is the context use as of its last complete line. */
class Transcript {
  constructor(file, kind) {
    this.file = file;
    this.parser = kind === "claude" ? new ClaudeLog() : new CodexLog();
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.skipFirst = false;
  }

  async usage() {
    const { size } = await fs.promises.stat(this.file);
    if (size < this.offset) { // rewritten: start over
      this.parser = this.parser.fresh();
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size > this.offset) await this.readTo(size);
    return this.parser.usage();
  }

  async readTo(size) {
    let start = this.offset;
    if (start === 0 && size > FIRST_READ_MAX) { start = size - FIRST_READ_MAX; this.skipFirst = true; }
    const stream = fs.createReadStream(this.file, { start, end: size - 1, highWaterMark: 1 << 20 });
    for await (const buf of stream) {
      let from = 0, nl;
      while ((nl = buf.indexOf(10, from)) !== -1) {
        const line = this.rest.length ? Buffer.concat([this.rest, buf.subarray(from, nl)]) : buf.subarray(from, nl);
        this.rest = Buffer.alloc(0);
        from = nl + 1;
        if (this.skipFirst) { this.skipFirst = false; continue; } // started mid-line
        if (this.parser.wants(line)) {
          try { this.parser.add(JSON.parse(line.toString("utf8"))); } catch {}
        }
      }
      this.rest = Buffer.concat([this.rest, buf.subarray(from)]);
    }
    this.offset = size;
  }
}

/**
 * Claude Code: every model call's `message.usage`. What the call sent (input,
 * cache writes and cache reads) is what is in the context now, as `/context`
 * and the status line count it. A compaction resets it to `postTokens`.
 */
class ClaudeLog {
  used = null;
  model = null;

  fresh() { return new ClaudeLog(); }

  wants(line) {
    return line.includes('"usage"') || line.includes('"compact_boundary"') || line.includes('"modelId"');
  }

  add(e) {
    if (e.isSidechain) return;
    if (e.type === "assistant") {
      const u = e.message?.usage;
      if (!u || e.message.model === "<synthetic>") return;
      const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (used > 0) this.used = used;
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      const post = e.compactMetadata?.postTokens;
      this.used = typeof post === "number" ? post : null;
    } else if (e.type === "attachment" && e.attachment?.type === "model") {
      this.model = e.attachment.identity?.modelId ?? this.model;
    }
  }

  usage() {
    if (this.used === null) return null;
    // Without the model line, a count past the default window can only be a 1M one.
    const big = /\[1m\]/i.test(this.model ?? "") || this.used > CLAUDE_WINDOW;
    return { used: this.used, max: big ? CLAUDE_WINDOW_1M : CLAUDE_WINDOW };
  }
}

/** Codex: `token_count` events carry the last call's tokens and the model's window. */
class CodexLog {
  used = null;
  max = null;

  fresh() { return new CodexLog(); }

  wants(line) { return line.includes('"token_count"'); }

  add(e) {
    const info = e.type === "event_msg" && e.payload?.type === "token_count" ? e.payload.info : null;
    if (!info) return;
    if (typeof info.last_token_usage?.total_tokens === "number") this.used = info.last_token_usage.total_tokens;
    if (typeof info.model_context_window === "number") this.max = info.model_context_window;
  }

  usage() {
    return this.used !== null && this.max ? { used: this.used, max: this.max } : null;
  }
}
