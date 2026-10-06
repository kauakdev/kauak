// The printer in every room: each time a file in the room's git checkout
// changes, the bridge prints a sheet with what that edit changed.
//
// A room is matched to a checkout by folder (its worktree's checkout path, or
// its first pane's cwd) and `git rev-parse --show-toplevel`; rooms in one
// checkout share its printer. Every POLL_MS each checkout is scanned with
// `git status` (without optional locks, so agents' own git commands never
// trip over ours), and every changed file whose size or mtime moved is read
// and compared with the version seen last: the first time, the one in HEAD.
// That difference is the sheet: one edit, not the file's whole diff. Files
// already changed when the bridge starts are the baseline and print nothing;
// they show in the uncommitted view, which a page asks for when it wants it:
// everything not committed (`git diff` against HEAD, staged or not, and the
// untracked files), one page per file.
//
// On this machine the bridge runs git and reads the files itself. On a
// remote floor diffs_remote.py does just that part, over SSH (remote.js), and
// everything else still happens here.

import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { RemoteScript } from "./remote.js";

const POLL_MS = 2000;
// A folder outside git is asked again after this long (it may become a repository).
const ROOT_TTL_MS = 30_000;
// A checkout git cannot read (removed worktree…) is left alone this long.
const FAIL_MS = 30_000;
// Changed files looked at per scan, and the largest one read.
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;
// Sheets kept per checkout, rows per file, characters per row.
const MAX_SHEETS = 50;
const MAX_DIFF_LINES = 800;
const MAX_LINE = 400;
const CONTEXT = 3;
// The largest middle section (old rows × new rows) diffed line by line; past that it is all replaced.
const LCS_CELLS = 1_000_000;
const GIT_TIMEOUT_MS = 15_000;
const MAX_GIT_OUT = 16 * 1024 * 1024;
// The uncommitted view: how much `git diff` is read, how many files and rows
// it prints, how many untracked files are read, and how long a remote floor
// gets to send it all.
const MAX_DIFF_OUT = 8 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_TOTAL_LINES = 20_000;
const MAX_UNTRACKED = 100;
const UNCOMMITTED_TIMEOUT_MS = 60_000;

// A file whose contents are not shown, only that it changed.
const BINARY = Symbol("binary");
const LARGE = Symbol("large");

let sheetSeq = 0;

/** A remote floor's helper is not running (it says why in the log when it stops). */
class HostDown extends Error {
  constructor() { super("the remote helper is not running"); }
}

/**
 * Emits "print" with each new sheet and "change" when rooms move to another
 * checkout (`annotate` then gives the snapshot each room's `git_root`).
 */
export class DiffTracker extends EventEmitter {
  constructor(machine) {
    super();
    this.m = machine;
    this.host = machine.ssh ? new RemoteHost(machine) : new LocalHost();
    /** folder → { root, at } */
    this.folders = new Map();
    /** git root → Checkout */
    this.checkouts = new Map();
    /** git root → sheets, oldest first */
    this.sheets = new Map();
    /** workspace id → git root */
    this.roots = new Map();
    this.updating = false;
    this.again = false;
    this.stopped = false;
    machine.on("snapshot", () => this.update());
    this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.host.stop();
  }

  annotate(snapshot) {
    if (!snapshot || this.roots.size === 0) return snapshot;
    return { ...snapshot, workspaces: snapshot.workspaces.map((w) => ({ ...w, git_root: this.roots.get(w.workspace_id) ?? null })) };
  }

  /** Every sheet still kept, oldest first. */
  history() {
    return [...this.sheets.values()].flat().sort((a, b) => a.at - b.at);
  }

  /** Everything not committed in a checkout a room is in: { files, incomplete, error? }. */
  async uncommitted(root) {
    const co = this.checkouts.get(root);
    if (!co) return { files: [], incomplete: false, error: "That room is not in a git checkout." };
    try {
      return await co.uncommitted();
    } catch (err) {
      return { files: [], incomplete: false, error: err instanceof HostDown ? `${this.m.label} is not answering.` : lastLine(err) };
    }
  }

  update() {
    if (this.updating) { this.again = true; return; }
    this.updating = true;
    this.resolveRooms().catch((err) => console.error(`[bridge] ${this.m.label}: printers:`, err.message)).finally(() => {
      this.updating = false;
      if (this.again) { this.again = false; this.update(); }
    });
  }

  async resolveRooms() {
    const snap = this.m.snapshot;
    if (!snap) return;
    const next = new Map();
    for (const ws of snap.workspaces) {
      const folder = ws.worktree?.checkout_path ?? snap.panes.find((p) => p.workspace_id === ws.workspace_id)?.cwd;
      const root = folder ? await this.rootOf(folder) : null;
      if (root) next.set(ws.workspace_id, root);
    }
    if (this.stopped) return;
    const used = new Set(next.values());
    for (const root of [...this.checkouts.keys()]) {
      if (!used.has(root)) { this.checkouts.delete(root); this.sheets.delete(root); }
    }
    for (const root of used) if (!this.checkouts.has(root)) this.checkouts.set(root, new Checkout(root, this.host));
    if (!sameMap(next, this.roots)) {
      this.roots = next;
      this.emit("change");
    }
  }

  async rootOf(folder) {
    const known = this.folders.get(folder);
    if (known && (known.root || Date.now() - known.at < ROOT_TTL_MS)) return known.root;
    let root = null;
    try {
      root = (await this.host.git(folder, ["rev-parse", "--show-toplevel"])).out.toString().trim() || null;
    } catch (err) {
      if (err instanceof HostDown) return known?.root ?? null; // ask again once it is back
    }
    this.folders.set(folder, { root, at: Date.now() });
    return root;
  }

  async poll() {
    for (const co of [...this.checkouts.values()]) {
      if (this.stopped) return;
      if (this.checkouts.get(co.root) !== co || Date.now() < co.failedUntil) continue;
      try {
        for (const sheet of await co.scan()) this.print(co.root, sheet);
      } catch (err) {
        if (err instanceof HostDown) break;
        // The checkout may be gone: look its rooms' folders up again on the next snapshot.
        co.failedUntil = Date.now() + FAIL_MS;
        for (const [folder, f] of this.folders) if (f.root === co.root) this.folders.delete(folder);
        console.warn(`[bridge] ${this.m.label}: cannot read ${co.root}: ${lastLine(err)}`);
      }
    }
    if (!this.stopped) this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  print(root, sheet) {
    sheet.root = root;
    const list = this.sheets.get(root) ?? [];
    list.push(sheet);
    if (list.length > MAX_SHEETS) list.splice(0, list.length - MAX_SHEETS);
    this.sheets.set(root, list);
    this.emit("print", sheet);
  }
}

/** One git checkout: the last contents seen of each changed file. */
class Checkout {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    /** repo-relative path → { sig, content } */
    this.files = new Map();
    this.ready = false;
    this.failedUntil = 0;
  }

  /** The sheets for what changed since the last scan (none on the first: that is the baseline). */
  async scan() {
    const status = parseStatus((await this.host.git(this.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).out.toString("utf8"));
    const paths = [...new Set([...status.keys(), ...this.files.keys()])];
    const stats = paths.length ? await this.host.stat(this.root, paths) : new Map();
    const changed = [];
    for (const file of paths) {
      const st = stats.get(file) ?? null;
      if (st === "other") continue; // a submodule or symlink
      const known = this.files.get(file);
      if (known?.sig === (st ?? "-")) {
        if (!status.has(file)) this.files.delete(file); // committed
        continue;
      }
      changed.push(file);
    }
    if (!changed.length) { this.ready = true; return []; }
    const present = changed.filter((f) => stats.get(f));
    const contents = present.length ? await this.host.read(this.root, present) : new Map();
    const fresh = this.ready ? changed.filter((f) => !this.files.has(f)) : [];
    const heads = fresh.length ? await this.headContents(fresh.map((f) => status.get(f)?.orig ?? f)) : new Map();
    const sheets = [];
    for (const file of changed) {
      const now = decode(contents.get(file) ?? null);
      const known = this.files.get(file);
      const before = known ? known.content : this.ready ? heads.get(status.get(file)?.orig ?? file) ?? null : undefined;
      if (status.has(file)) this.files.set(file, { sig: stats.get(file) ?? "-", content: now });
      else this.files.delete(file); // back to what HEAD has
      if (before === undefined) continue;
      const sheet = makeSheet(file, before, now);
      if (sheet) sheets.push(sheet);
    }
    this.ready = true;
    return sheets;
  }

  /** What HEAD has at each path (null where it has nothing), in one `git cat-file --batch`. */
  async headContents(paths) {
    const result = new Map(paths.map((p) => [p, null]));
    const asked = paths.filter((p) => !p.includes("\n"));
    if (!asked.length) return result;
    const { out } = await this.host.git(this.root, ["cat-file", "--batch"], { input: Buffer.from(asked.map((p) => `HEAD:${p}\n`).join("")) });
    let at = 0;
    for (const p of asked) {
      const nl = out.indexOf(10, at);
      if (nl === -1) break;
      const m = /^[0-9a-f]{40,64} (\w+) (\d+)$/.exec(out.subarray(at, nl).toString("utf8"));
      at = nl + 1;
      if (!m) continue; // "missing": not in HEAD
      const size = Number(m[2]);
      if (m[1] === "blob") result.set(p, decode(out.subarray(at, at + size)));
      at += size + 1;
    }
    return result;
  }

  /** Everything not committed: `git diff` against HEAD and the untracked files, one page per file, by path. */
  async uncommitted() {
    const opts = { timeout: UNCOMMITTED_TIMEOUT_MS };
    // A repository without commits yet is compared with the empty tree.
    const base = await this.host.git(this.root, ["rev-parse", "-q", "--verify", "HEAD"], opts).then(() => "HEAD",
      async () => (await this.host.git(this.root, ["hash-object", "-t", "tree", "--stdin"], { ...opts, input: Buffer.alloc(0) })).out.toString().trim());
    const diff = await this.host.git(this.root, [
      "diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--find-renames",
      "--src-prefix=a/", "--dst-prefix=b/", `-U${CONTEXT}`, "--",
    ], { ...opts, max: MAX_DIFF_OUT });
    const pages = parseGitDiff(diff.out.toString("utf8"));
    let incomplete = diff.truncated;
    const untracked = (await this.host.git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"], opts)).out.toString("utf8").split("\0").filter(Boolean);
    const read = untracked.slice(0, MAX_UNTRACKED);
    const contents = read.length ? await this.host.read(this.root, read, opts) : new Map();
    for (const file of untracked) {
      const page = { path: file, change: "added", untracked: true, added: 0, removed: 0, diff: "", truncated: false };
      const content = contents.has(file) ? decode(contents.get(file)) : undefined;
      if (content === undefined) pages.push({ ...page, note: "Not printed: too many new files." });
      else if (content === null) continue; // gone since git listed it
      else if (typeof content === "symbol") pages.push({ ...page, note: content === LARGE ? "Too large to print." : "Binary file." });
      else pages.push({ ...page, ...lineDiff([], lines(content)) });
    }
    pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (pages.length > MAX_PAGES) { pages.length = MAX_PAGES; incomplete = true; }
    let total = 0;
    for (const page of pages) {
      const n = page.diff ? page.diff.split("\n").length : 0;
      if (total + n <= MAX_TOTAL_LINES) { total += n; continue; }
      Object.assign(page, { diff: "", truncated: false, note: "Not printed: there was too much to print." });
      incomplete = true;
    }
    return { files: pages, incomplete };
  }
}

// ---------------------------------------------------------------- hosts
//
// Where git runs and files are read: git(cwd, args, { input, max, timeout })
// resolves with { out, truncated } (rejecting when git fails), stat(root,
// paths) with path → "size:mtime" | "other" | null, and read(root, paths) with
// path → Buffer | LARGE | null.

class LocalHost {
  stop() {}

  git(cwd, args, { input = null, max = MAX_GIT_OUT } = {}) {
    return new Promise((resolve, reject) => {
      const child = execFile("git", ["-c", "core.quotepath=off", ...args], {
        cwd, encoding: "buffer", maxBuffer: max, timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }, (err, stdout, stderr) => {
        // Past maxBuffer git is stopped, and what came until then is kept.
        if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") resolve({ out: stdout, truncated: true });
        else if (err) reject(Object.assign(err, { stderr }));
        else resolve({ out: stdout, truncated: false });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? undefined);
    });
  }

  async stat(root, paths) {
    const stats = await Promise.all(paths.map((p) => fs.promises.lstat(path.join(root, p)).catch(() => null)));
    return new Map(paths.map((p, i) => {
      const st = stats[i];
      return [p, !st ? null : st.isFile() ? `${st.size}:${st.mtimeMs}` : "other"];
    }));
  }

  async read(root, paths) {
    const out = await Promise.all(paths.map(async (p) => {
      const file = path.join(root, p);
      const st = await fs.promises.stat(file).catch(() => null);
      if (!st) return null;
      if (st.size > MAX_BYTES) return LARGE;
      return fs.promises.readFile(file).catch(() => null);
    }));
    return new Map(paths.map((p, i) => [p, out[i]]));
  }
}

/** The same, on a remote floor, through diffs_remote.py. */
class RemoteHost {
  constructor(machine) {
    this.script = new RemoteScript(machine, "./diffs_remote.py", "printers");
  }

  stop() {
    this.script.stop();
  }

  async call(request, timeout) {
    const result = await this.script.call(request, timeout);
    if (result == null) throw new HostDown();
    return result;
  }

  async git(cwd, args, { input = null, max = MAX_GIT_OUT, timeout } = {}) {
    const r = await this.call({ op: "git", cwd, args, input: input ? input.toString("base64") : null, max }, timeout);
    if (!r.ok) throw Object.assign(new Error(r.err || `git ${args[0]} failed`), { stderr: r.err });
    return { out: Buffer.from(r.out, "base64"), truncated: r.truncated };
  }

  async stat(root, paths) {
    return new Map(Object.entries(await this.call({ op: "stat", root, paths })));
  }

  async read(root, paths, { timeout } = {}) {
    const r = await this.call({ op: "read", root, paths, max: MAX_BYTES }, timeout);
    return new Map(Object.entries(r).map(([p, v]) => [p, v === "large" ? LARGE : v === null ? null : Buffer.from(v, "base64")]));
  }
}

// ---------------------------------------------------------------- git output

/** `git status --porcelain=v1 -z`: path → { code, orig } (orig: where a rename came from). */
function parseStatus(out) {
  const entries = new Map();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length && entries.size < MAX_FILES; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    const orig = code[0] === "R" || code[0] === "C" ? parts[++i] ?? null : null;
    entries.set(e.slice(3), { code, orig });
  }
  return entries;
}

/** `git diff` output as one page per file: path, change, counts and its hunks. */
export function parseGitDiff(text) {
  const pages = [];
  let page = null, rows = [], inHunk = false, mode = false;
  const done = () => {
    if (!page) return;
    page.diff = rows.join("\n");
    if (!page.diff && !page.note) page.note = page.change === "renamed" ? "Renamed; the contents did not change." : mode ? "Only the file's mode changed." : "Nothing to print.";
    pages.push(page);
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      done();
      page = { path: gitLinePath(line.slice(11)), change: "modified", added: 0, removed: 0, diff: "", truncated: false };
      rows = []; inHunk = false; mode = false;
      continue;
    }
    if (!page) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) page.change = "added";
      else if (line.startsWith("deleted file mode")) page.change = "deleted";
      else if (line.startsWith("old mode")) mode = true;
      else if (line.startsWith("rename from ")) { page.change = "renamed"; page.from = unquote(line.slice(12)); }
      else if (line.startsWith("rename to ")) page.path = unquote(line.slice(10));
      else if (line.startsWith("--- ") && line !== "--- /dev/null") page.path = headerPath(line.slice(4), "a/");
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") page.path = headerPath(line.slice(4), "b/");
      else if (line.startsWith("Binary files ")) page.note = "Binary file.";
      if (!line.startsWith("@@")) continue;
      inHunk = true;
    }
    const kind = line[0];
    if (kind === "+") page.added++;
    else if (kind === "-") page.removed++;
    else if (kind !== " " && kind !== "@") continue; // "\ No newline at end of file", the final ""
    if (rows.length >= MAX_DIFF_LINES) { page.truncated = true; continue; }
    rows.push(line.length > MAX_LINE + 1 ? line.slice(0, MAX_LINE + 1) + "…" : line);
  }
  done();
  return pages;
}

/** The path in "a/<p> b/<p>" (only needed when no ---/+++ lines follow: binary or mode-only changes). */
function gitLinePath(s) {
  const n = (s.length - 5) / 2;
  if (Number.isInteger(n) && s.startsWith("a/") && s.slice(2 + n) === ` b/${s.slice(2, 2 + n)}`) return s.slice(2, 2 + n);
  const b = s.lastIndexOf(" b/");
  return unquote(b > 0 ? s.slice(b + 3) : s);
}

/** "a/path" or "b/path" in a ---/+++ line; git ends it with a tab when the path has a space. */
function headerPath(s, prefix) {
  const p = unquote(s.replace(/\t$/, ""));
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** A path git quoted C-style ("tab\there"): with core.quotepath off only control characters, quotes and backslashes are escaped. */
function unquote(s) {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const bytes = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { bytes.push(...Buffer.from(body[i])); continue; }
    const c = body[++i] ?? "";
    if (/[0-7]/.test(c)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bytes.push({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 }[c] ?? c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

// ---------------------------------------------------------------- diffs

/** File bytes as text, or BINARY / LARGE; null stays null (no file). */
function decode(buf) {
  if (buf === null || typeof buf === "symbol") return buf;
  if (buf.length > MAX_BYTES) return LARGE;
  return buf.subarray(0, 8000).includes(0) ? BINARY : buf.toString("utf8");
}

/** A sheet for one file going from `before` to `after` (null: the file does not exist), or null if nothing changed. */
function makeSheet(file, before, after) {
  if (before === after && typeof before !== "symbol") return null;
  const sheet = {
    id: `${Date.now().toString(36)}-${(++sheetSeq).toString(36)}`,
    path: file,
    change: before === null ? "added" : after === null ? "deleted" : "modified",
    at: Date.now(),
  };
  if (typeof before === "symbol" || typeof after === "symbol") {
    const note = before === LARGE || after === LARGE ? "Too large to print." : "Binary file.";
    return { ...sheet, added: 0, removed: 0, diff: "", truncated: false, note };
  }
  const d = lineDiff(before === null ? [] : lines(before), after === null ? [] : lines(after));
  return d.added || d.removed ? { ...sheet, ...d } : null;
}

function lines(text) {
  const rows = text.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  return rows.map((r) => (r.endsWith("\r") ? r.slice(0, -1) : r));
}

/** Unified hunks from `a` to `b`, with counts. */
export function lineDiff(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops = a.slice(0, pre).map((t) => [" ", t]);
  ops.push(...middle(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)));
  for (let i = a.length - suf; i < a.length; i++) ops.push([" ", a[i]]);
  return hunks(ops);
}

/** Line ops for the changed middle: a longest common subsequence, or all replaced when it is too big for that. */
function middle(A, B) {
  const n = A.length, m = B.length;
  if (n * m > LCS_CELLS) return [...A.map((t) => ["-", t]), ...B.map((t) => ["+", t])];
  const w = m + 1;
  const L = new Uint16Array((n + 1) * w); // n × m ≤ LCS_CELLS keeps every length under 65536
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push([" ", A[i]]); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(["-", A[i++]]);
    else out.push(["+", B[j++]]);
  }
  while (i < n) out.push(["-", A[i++]]);
  while (j < m) out.push(["+", B[j++]]);
  return out;
}

function hunks(ops) {
  let added = 0, removed = 0;
  const changes = [];
  // Old and new line numbers at each op.
  const oldAt = new Int32Array(ops.length + 1), newAt = new Int32Array(ops.length + 1);
  for (let k = 0, o = 1, n = 1; k <= ops.length; k++) {
    oldAt[k] = o; newAt[k] = n;
    const kind = ops[k]?.[0];
    if (kind === "+") { added++; n++; changes.push(k); }
    else if (kind === "-") { removed++; o++; changes.push(k); }
    else if (kind === " ") { o++; n++; }
  }
  const out = [];
  let truncated = false;
  for (let c = 0; c < changes.length && !truncated; c++) {
    const start = Math.max(0, changes[c] - CONTEXT);
    let end = changes[c];
    while (c + 1 < changes.length && changes[c + 1] - end <= CONTEXT * 2 + 1) end = changes[++c];
    const slice = ops.slice(start, Math.min(ops.length, end + CONTEXT + 1));
    const oldLen = slice.filter(([k]) => k !== "+").length, newLen = slice.filter(([k]) => k !== "-").length;
    // As git writes them: an empty side starts at the line before.
    out.push(`@@ -${oldAt[start] - (oldLen ? 0 : 1)},${oldLen} +${newAt[start] - (newLen ? 0 : 1)},${newLen} @@`);
    for (const [k, t] of slice) out.push(k + (t.length > MAX_LINE ? t.slice(0, MAX_LINE) + "…" : t));
    if (out.length > MAX_DIFF_LINES) truncated = true;
  }
  return { added, removed, diff: out.slice(0, MAX_DIFF_LINES).join("\n"), truncated };
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function lastLine(err) {
  const text = err.stderr?.toString() || err.message;
  return text.trim().split("\n").pop();
}
