// Context meters: how full each agent's context window is. Neither Herdr nor
// the agents expose this over an API, but both Claude Code and Codex log the
// token count of every model call to a transcript file on disk, so the bridge
// reads those and adds `context: { used, max }` to the panes in the snapshots
// it sends out. On this machine it reads the files itself; for a remote floor
// it runs context_remote.py there over SSH, which reads them the same way.
//
// Which transcript belongs to which pane:
// - Herdr's agent integrations (`herdr integration install claude`) report the
//   session on start, a transcript path or a session id (`paneSession`).
// - Without it, a Claude Code pane is matched through its process: Claude
//   Code keeps ~/.claude/sessions/<pid>.json with the session id and folder of
//   each running instance (verified on 2.1.286; not a documented interface).
// - Without it, a Codex pane gets the newest terminal Codex rollout
//   (`originator: "codex-tui"`) for the pane's folder written since Codex
//   started there. Codex 0.159 runs its sessions in a shared daemon, so
//   nothing on disk ties a pane's process to its session; when two Codex
//   panes share a folder there is no telling which is which, and neither gets
//   a meter.
// The pane's processes come from Herdr (`paneProcesses`). The floor's Machine
// (machine.ts) asks Herdr for both; this file only sees its Kauak snapshot.
//
// Transcripts only grow, so each one is read incrementally from where the
// last read stopped.

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { ContextUsage, MachineInfo, PaneInfo, Snapshot } from "@kauak/protocol";
import type { BridgeConfig } from "./config.ts";
import { RemoteScript } from "./remote.ts";

const KINDS: ReadonlySet<string | null> = new Set(["claude", "codex"]);
const POLL_MS = 2000;
// A snapshot often means the agent just wrote to its transcript (a status change).
const KICK_MS = 300;
// Where nothing matched, wait this long before searching again (process_info is a Herdr round trip).
const MISS_MS = 15_000;
// The first read of a long transcript starts this far from its end. The model
// line near the start may be skipped, and then the window size is a guess.
const FIRST_READ_MAX = 32 * 1024 * 1024;
// Claude's context window: 1M tokens on current models. Haiku and the models
// up to Opus/Sonnet 4.5 have 200k, unless Claude Code runs them as "[1m]".
const CLAUDE_WINDOW = 1_000_000;
const CLAUDE_WINDOW_SMALL = 200_000;
const CLAUDE_SMALL_MODEL = /^claude-(?:3|haiku)|^claude-(?:opus|sonnet)-4(?:-[015])?(?:-\d{8})?$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What the tracker uses of its floor's Machine, which it is handed: it reads
 * the Kauak snapshot and asks for a pane's agent session and processes, and
 * never imports the Herdr adapter.
 */
interface Floor {
  readonly label: string;
  readonly ssh: string | null;
  readonly state: MachineInfo["state"];
  readonly snapshot: Snapshot | null;
  on(event: "snapshot", listener: () => void): unknown;
  paneSession(paneId: string): AgentSession | null;
  paneProcesses(paneId: string): Promise<number[]>;
}

/** The agent session Herdr's integration reported for a pane: a transcript path or a session id. */
interface AgentSession {
  kind: "id" | "path";
  value: string;
}

/** What the tracker uses of the bridge's config: this machine's agent folders, and the ssh executable for a remote floor. */
type ContextSettings = Pick<BridgeConfig, "claudeDir" | "codexDir" | "sshCommand">;
/** Where this machine's agents keep their transcripts. */
type AgentDirs = Pick<BridgeConfig, "claudeDir" | "codexDir">;

/**
 * Emits "change" when any pane's context use changes. The tracker decides
 * which panes to read and how to find their sessions (through Herdr); a
 * reader turns that into token counts, here or over SSH.
 */
export class ContextTracker extends EventEmitter {
  m: Floor;
  reader: LocalReader | RemoteReader;
  /** pane_id → { used, max } */
  usage: Map<string, ContextUsage>;
  /** pane_id → pid of its agent's process (Claude Code's, or Codex's) */
  pids: Map<string, number>;
  /** pane_id → when to ask Herdr for its processes again */
  misses: Map<string, number>;
  running: boolean;
  again: boolean;
  kickTimer: NodeJS.Timeout | null;
  timer: NodeJS.Timeout;

  constructor(machine: Floor, settings: ContextSettings) {
    super();
    this.m = machine;
    this.reader = machine.ssh ? new RemoteReader(machine, settings.sshCommand) : new LocalReader(settings);
    this.usage = new Map();
    this.pids = new Map();
    this.misses = new Map();
    this.running = false;
    this.again = false;
    this.kickTimer = null;
    this.timer = setInterval(() => this.refresh(), POLL_MS);
    this.timer.unref();
    machine.on("snapshot", () => this.kick());
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.kickTimer as NodeJS.Timeout);
    this.reader.stop();
  }

  /** The Kauak snapshot with `context` on every pane whose use is known. */
  annotate(snapshot: Snapshot | null): Snapshot | null {
    if (!snapshot || this.usage.size === 0) return snapshot;
    return {
      ...snapshot,
      panes: snapshot.panes.map((p) => (this.usage.has(p.pane_id) ? { ...p, context: this.usage.get(p.pane_id)! } : p)),
    };
  }

  kick() {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      this.refresh();
    }, KICK_MS);
  }

  async refresh() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        await this.update();
      } while (this.again);
    } catch (err) {
      console.error(`[bridge] ${this.m.label}: context meters:`, (err as Error).message);
    } finally {
      this.running = false;
    }
  }

  async update() {
    const snap = this.m.snapshot;
    if (!snap || this.m.state !== "live") return;
    const panes: PaneToRead[] = [];
    const asked = new Set<string>(); // panes whose processes came from Herdr just now, not from the cache
    const sessionOf = (pane: PaneInfo) => this.m.paneSession(pane.pane_id);
    const folderOf = (pane: PaneInfo) => pane.cwd;
    // Codex panes without a session are matched by folder, so one folder must not have two.
    const codexFolders = new Map<string | null, number>();
    for (const pane of snap.panes) {
      if (pane.agent === "codex" && !sessionOf(pane)) codexFolders.set(folderOf(pane), (codexFolders.get(folderOf(pane)) ?? 0) + 1);
    }
    for (const pane of snap.panes) {
      if (!KINDS.has(pane.agent)) continue;
      const session = sessionOf(pane);
      let pids: number[] = [];
      if (!session && (pane.agent === "claude" || codexFolders.get(folderOf(pane)) === 1)) {
        const known = this.pids.get(pane.pane_id);
        if (known) pids = [known];
        else if ((this.misses.get(pane.pane_id) ?? 0) <= Date.now()) {
          asked.add(pane.pane_id);
          pids = await this.processesOf(pane.pane_id);
        }
      }
      panes.push({ pane_id: pane.pane_id, agent: pane.agent, session, pids, cwd: folderOf(pane) });
    }
    const results = panes.length ? await this.reader.read(panes) : new Map();
    if (!results) return; // the remote reader is down; keep what we had
    const next = new Map<string, ContextUsage>();
    for (const p of panes) {
      const r = results.get(p.pane_id);
      if (r?.usage) next.set(p.pane_id, r.usage);
      if (r?.pid) {
        this.pids.set(p.pane_id, r.pid);
        this.misses.delete(p.pane_id);
      } else if (p.pids.length || asked.has(p.pane_id)) {
        // A remembered pid that stopped matching (Claude restarted) is looked up again right away.
        this.pids.delete(p.pane_id);
        if (asked.has(p.pane_id)) this.misses.set(p.pane_id, Date.now() + MISS_MS);
      }
    }
    const live = new Set(snap.panes.map((p) => p.pane_id));
    for (const id of [...this.pids.keys()]) if (!live.has(id)) this.pids.delete(id);
    if (sameUsage(next, this.usage)) return;
    this.usage = next;
    this.emit("change");
  }

  processesOf(paneId: string) {
    return this.m.paneProcesses(paneId).catch(() => []);
  }
}

function sameUsage(a: Map<string, ContextUsage>, b: Map<string, ContextUsage>) {
  if (a.size !== b.size) return false;
  for (const [id, u] of a) {
    const v = b.get(id);
    if (!v || v.used !== u.used || v.max !== u.max) return false;
  }
  return true;
}

// ---------------------------------------------------------------- readers
//
// read(panes) takes [{ pane_id, agent, session, pids, cwd }] and resolves with
// Map(pane_id → { usage: { used, max } | null, pid: number | null }), where
// `pid` is the one of `pids` that is the agent (Claude Code's, or the first
// Codex process); or null if it could not read.

interface PaneToRead {
  pane_id: string;
  agent: string | null;
  session: AgentSession | null;
  pids: number[];
  cwd: string | null;
}

interface ReadResult {
  usage: ContextUsage | null;
  pid: number | null;
}

/** A Codex rollout's `session_meta`, as rolloutMeta reads it. */
interface RolloutMeta {
  cwd?: string | null;
  originator?: string | null;
  source?: unknown;
}

/** Reads this machine's transcripts. context_remote.py does the same on a remote one. */
class LocalReader {
  dirs: AgentDirs;
  /** transcript path → Transcript */
  transcripts: Map<string, Transcript>;
  /** kind:session id → transcript path */
  found: Map<string, string>;
  /** kind:session id → when to look again */
  misses: Map<string, number>;
  /** rollout path → its session_meta: { cwd, originator, source } */
  rollouts: Map<string, RolloutMeta>;

  constructor(dirs: AgentDirs) {
    this.dirs = dirs;
    this.transcripts = new Map();
    this.found = new Map();
    this.misses = new Map();
    this.rollouts = new Map();
  }

  stop() {}

  async read(panes: PaneToRead[]): Promise<Map<string, ReadResult>> {
    const results = new Map<string, ReadResult>();
    const read = new Set<string>();
    for (const pane of panes) {
      const { file, pid } = await this.transcriptOf(pane).catch(() => ({ file: null, pid: null }));
      let usage: ContextUsage | null = null;
      if (file) {
        read.add(file);
        let t = this.transcripts.get(file);
        if (!t) this.transcripts.set(file, (t = new Transcript(file, pane.agent)));
        usage = await t.usage().catch(() => null);
      }
      results.set(pane.pane_id, { usage, pid });
    }
    for (const file of [...this.transcripts.keys()]) if (!read.has(file)) this.transcripts.delete(file);
    return results;
  }

  async transcriptOf({ agent, session, pids, cwd }: PaneToRead): Promise<{ file: string | null; pid: number | null }> {
    // Herdr 0.9.1 shows the id even when the hook reported the path too.
    if (session?.kind === "path") return { file: session.value.endsWith(".jsonl") ? session.value : null, pid: null };
    if (session?.kind === "id") return { file: await this.find(agent, session.value, cwd), pid: null };
    if (agent === "codex") {
      // The pid is kept even before the first rollout shows up, so the next read looks again.
      const started = await processStart(pids);
      return started ? { file: await this.codexByFolder(cwd, started.at), pid: started.pid } : { file: null, pid: null };
    }
    for (const pid of pids) {
      const meta = await readSessionFile(this.dirs.claudeDir, pid);
      if (meta) return { file: await this.find("claude", meta.sessionId, meta.cwd), pid };
    }
    return { file: null, pid: null };
  }

  /** The newest terminal Codex rollout for `cwd` written since `since` (when Codex started), from the day it started on. */
  async codexByFolder(cwd: string | null, since: number) {
    let best: string | null = null,
      bestTime = 0;
    for (const dir of codexDayDirs(this.dirs.codexDir, since)) {
      for (const name of await fs.promises.readdir(dir).catch(() => [])) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        const st = await fs.promises.stat(file).catch(() => null);
        if (!st || st.mtimeMs < since || st.mtimeMs <= bestTime) continue;
        let meta: RolloutMeta | null | undefined = this.rollouts.get(file);
        if (!meta) {
          meta = await rolloutMeta(file).catch(() => null);
          if (meta) this.rollouts.set(file, meta);
        }
        // A subagent's rollout has an object for `source`.
        if (meta?.cwd === cwd && meta.originator === "codex-tui" && typeof meta.source === "string") {
          best = file;
          bestTime = st.mtimeMs;
        }
      }
    }
    return best;
  }

  /** A session id's transcript. Remembered once found; a miss is retried after a while (the file shows up with the first message). */
  async find(kind: string | null, id: string, cwd: string | null = null) {
    if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
    const key = `${kind}:${id}`;
    const known = this.found.get(key);
    if (known && fs.existsSync(known)) return known;
    if ((this.misses.get(key) ?? 0) > Date.now()) return null;
    const file =
      kind === "claude" ? await findClaudeTranscript(this.dirs.claudeDir, id, cwd) : await findCodexRollout(this.dirs.codexDir, id);
    if (file) {
      this.found.set(key, file);
      this.misses.delete(key);
    } else this.misses.set(key, Date.now() + MISS_MS);
    return file;
  }
}

/**
 * Runs context_remote.py on a remote floor's machine over its own SSH
 * connection, kept open across reads (the script keeps its caches), and
 * restarted when it dies.
 */
/** Runs context_remote.py on the floor's machine (with its python3; Herdr's own agent hooks need it too). */
class RemoteReader {
  script: RemoteScript;

  constructor(machine: Floor, sshCommand: string) {
    this.script = new RemoteScript(machine, sshCommand, "./context_remote.py", "context meters");
  }

  stop() {
    this.script.stop();
  }

  async read(panes: PaneToRead[]) {
    const result = await this.script.call<Record<string, ReadResult>>({ panes });
    return result ? new Map(Object.entries(result)) : null;
  }
}

/** The earliest-started of `pids` and when it started (ms), from `ps`. */
function processStart(pids: number[]) {
  if (!pids.length) return Promise.resolve(null);
  return new Promise<{ pid: number; at: number } | null>((resolve) => {
    execFile("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], { env: { ...process.env, LC_ALL: "C" } }, (_err, out) => {
      let best: { pid: number; at: number } | null = null;
      for (const line of String(out ?? "").split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        const at = m ? Date.parse(m[2]!) : NaN;
        if (!Number.isNaN(at) && (!best || at < best.at)) best = { pid: Number(m![1]), at };
      }
      resolve(best);
    });
  });
}

/** ~/.codex/sessions/YYYY/MM/DD for each day from the one before `since` (time zones) to today. */
function codexDayDirs(codexDir: string, since: number) {
  const dirs: string[] = [];
  const day = new Date(since - 86_400_000);
  day.setHours(12, 0, 0, 0);
  for (let i = 0; i < 31 && day.getTime() <= Date.now() + 86_400_000; i++, day.setDate(day.getDate() + 1)) {
    const pad = (n: number) => String(n).padStart(2, "0");
    dirs.push(path.join(codexDir, "sessions", String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate())));
  }
  return dirs;
}

/**
 * A rollout's first line, `session_meta`: { cwd, originator, source }; {} if
 * the line is something else, null while it is still being written.
 */
async function rolloutMeta(file: string): Promise<RolloutMeta | null> {
  const fh = await fs.promises.open(file, "r").catch(() => null);
  if (!fh) return null;
  try {
    // The first line carries the base instructions too, so it can be long.
    const buf = Buffer.alloc(1 << 20);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const nl = buf.subarray(0, bytesRead).indexOf(10);
    if (nl === -1) return null;
    let e: { type?: string; payload?: RolloutMeta } | null;
    try {
      e = JSON.parse(buf.subarray(0, nl).toString("utf8"));
    } catch {
      return {};
    }
    const p = e?.type === "session_meta" ? e.payload : null;
    return p ? { cwd: p.cwd ?? null, originator: p.originator ?? null, source: p.source ?? null } : {};
  } finally {
    await fh.close();
  }
}

/** Claude Code's ~/.claude/sessions/<pid>.json, the fields read here. */
interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  cwd?: string;
}

async function readSessionFile(claudeDir: string, pid: number): Promise<ClaudeSessionFile | null> {
  if (!Number.isInteger(pid) || !alive(pid)) return null;
  try {
    const meta = JSON.parse(await fs.promises.readFile(path.join(claudeDir, "sessions", `${pid}.json`), "utf8"));
    return meta.pid === pid && typeof meta.sessionId === "string" ? meta : null;
  } catch {
    return null;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ~/.claude/projects/<folder, non-alphanumerics as "-">/<id>.jsonl; any project folder if that is not it. */
async function findClaudeTranscript(claudeDir: string, id: string, cwd: string | null) {
  const projects = path.join(claudeDir, "projects");
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
async function findCodexRollout(codexDir: string, id: string) {
  const ls = async (dir: string) => (await fs.promises.readdir(dir).catch(() => [])).sort().reverse();
  const root = path.join(codexDir, "sessions");
  for (const y of await ls(root))
    for (const m of await ls(path.join(root, y)))
      for (const d of await ls(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d);
        const name = (await ls(dir)).find((f) => f.endsWith(`-${id}.jsonl`));
        if (name) return path.join(dir, name);
      }
  return null;
}

// ---------------------------------------------------------------- transcripts

/** One transcript, read incrementally; `usage()` is the context use as of its last complete line. Keep in step with context_remote.py. */
class Transcript {
  file: string;
  parser: ClaudeLog | CodexLog;
  offset: number;
  rest: Buffer;
  skipFirst: boolean;

  constructor(file: string, kind: string | null) {
    this.file = file;
    this.parser = kind === "claude" ? new ClaudeLog() : new CodexLog();
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.skipFirst = false;
  }

  async usage() {
    const { size } = await fs.promises.stat(this.file);
    if (size < this.offset) {
      // rewritten: start over
      this.parser = this.parser.fresh();
      this.offset = 0;
      this.rest = Buffer.alloc(0);
    }
    if (size > this.offset) await this.readTo(size);
    return this.parser.usage();
  }

  async readTo(size: number) {
    let start = this.offset;
    if (start === 0 && size > FIRST_READ_MAX) {
      start = size - FIRST_READ_MAX;
      this.skipFirst = true;
    }
    const stream = fs.createReadStream(this.file, { start, end: size - 1, highWaterMark: 1 << 20 });
    for await (const buf of stream) {
      let from = 0,
        nl: number;
      while ((nl = buf.indexOf(10, from)) !== -1) {
        const line = this.rest.length ? Buffer.concat([this.rest, buf.subarray(from, nl)]) : buf.subarray(from, nl);
        this.rest = Buffer.alloc(0);
        from = nl + 1;
        if (this.skipFirst) {
          this.skipFirst = false;
          continue;
        } // started mid-line
        if (this.parser.wants(line)) {
          try {
            this.parser.add(JSON.parse(line.toString("utf8")));
          } catch {}
        }
      }
      this.rest = Buffer.concat([this.rest, buf.subarray(from)]);
    }
    this.offset = size;
  }
}

/** The Claude Code transcript lines ClaudeLog reads, and the fields it reads of them; other lines are skipped. */
type ClaudeEntry = { isSidechain?: boolean } & (
  | {
      type: "assistant";
      message: {
        model?: string;
        usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      };
    }
  | { type: "system"; subtype?: string; compactMetadata?: { postTokens?: number } }
  | { type: "attachment"; attachment?: { type?: string; identity?: { modelId?: string } } }
);

/**
 * Claude Code: every model call's `message.usage`. What the call sent (input,
 * cache writes and cache reads) is what is in the context now, as `/context`
 * and the status line count it. A compaction resets it to `postTokens`.
 */
class ClaudeLog {
  used: number | null = null;
  /** The model of the last call, e.g. "claude-opus-5-5". */
  model: string | null = null;
  /** Claude Code's name for it, which ends in "[1m]" when it asked for the 1M window. */
  modelId: string | null = null;

  fresh() {
    return new ClaudeLog();
  }

  wants(line: Buffer) {
    return line.includes('"usage"') || line.includes('"compact_boundary"') || line.includes('"modelId"');
  }

  add(e: ClaudeEntry) {
    if (e.isSidechain) return;
    if (e.type === "assistant") {
      const u = e.message?.usage;
      if (!u || e.message.model === "<synthetic>") return;
      const used = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      if (used > 0) this.used = used;
      if (typeof e.message.model === "string") this.model = e.message.model;
    } else if (e.type === "system" && e.subtype === "compact_boundary") {
      const post = e.compactMetadata?.postTokens;
      this.used = typeof post === "number" ? post : null;
    } else if (e.type === "attachment" && e.attachment?.type === "model") {
      this.modelId = e.attachment.identity?.modelId ?? this.modelId;
    }
  }

  usage(): ContextUsage | null {
    if (this.used === null) return null;
    // A count past 200k can only be in a 1M window, whatever the model lines say.
    const small =
      this.used <= CLAUDE_WINDOW_SMALL && !/\[1m\]/i.test(this.modelId ?? "") && CLAUDE_SMALL_MODEL.test(this.model ?? this.modelId ?? "");
    return { used: this.used, max: small ? CLAUDE_WINDOW_SMALL : CLAUDE_WINDOW };
  }
}

/** The Codex rollout lines CodexLog reads, `token_count` events, and the fields it reads of them. */
interface CodexEntry {
  type?: string;
  payload?: { type?: string; info?: { last_token_usage?: { total_tokens?: number }; model_context_window?: number } | null };
}

/** Codex: `token_count` events carry the last call's tokens and the model's window. */
class CodexLog {
  used: number | null = null;
  max: number | null = null;

  fresh() {
    return new CodexLog();
  }

  wants(line: Buffer) {
    return line.includes('"token_count"');
  }

  add(e: CodexEntry) {
    const info = e.type === "event_msg" && e.payload?.type === "token_count" ? e.payload.info : null;
    if (!info) return;
    if (typeof info.last_token_usage?.total_tokens === "number") this.used = info.last_token_usage.total_tokens;
    if (typeof info.model_context_window === "number") this.max = info.model_context_window;
  }

  usage(): ContextUsage | null {
    return this.used !== null && this.max ? { used: this.used, max: this.max } : null;
  }
}
