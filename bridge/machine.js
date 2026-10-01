// One Herdr server, shown in the office as one floor.
//
// Herdr only listens on a local unix socket, so a remote machine is reached
// through an SSH tunnel that forwards a local unix socket to the remote one
// (`ssh -N -L <local.sock>:<remote.sock> host`). Every request then stays the
// same one-request-per-connection exchange as on the local machine; SSH opens
// a new channel per connection over the one login.
//
// Herdr protocol (v0.9.x, protocol 22):
//   - newline-delimited JSON over a unix socket
//   - one request per connection; the server closes after the response
//   - `events.subscribe` is the exception: the connection stays open and streams
//     `{"event": "...", "data": {...}}` envelopes

import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const LOCAL_SOCKET = process.env.HERDR_SOCKET_PATH ?? process.env.HERDR_SOCKET
  ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
export const SSH = process.env.AGENT_OFFICE_SSH ?? "ssh";
// BatchMode: never prompt for a password or host key; fail instead.
export const SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
const TUNNEL_DIR = path.join(os.tmpdir(), `agent-office-${process.getuid?.() ?? "user"}`);
const TUNNEL_READY_MS = 20_000;
const RETRY_MS = [2000, 4000, 8000, 15_000, 30_000];
const SNAPSHOT_DEBOUNCE_MS = 80;
// Runs on the remote machine (under `sh`, whatever the login shell is): print
// where Herdr's socket lives, exit 3 if it is not there.
const REMOTE_PROBE = `sh -c '${[
  `p="\${HERDR_SOCKET_PATH:-\${XDG_CONFIG_HOME:-$HOME/.config}/herdr/herdr.sock}"`,
  `printf "%s" "$p"`,
  `[ -S "$p" ] || exit 3`,
].join("; ")}'`;

// Events that change what the office looks like. pane.agent_status_changed
// needs a pane_id, so we rely on pane.updated (fires on status changes too).
const SUBSCRIPTIONS = [
  "workspace.created", "workspace.updated", "workspace.metadata_updated",
  "workspace.renamed", "workspace.moved", "workspace.reordered",
  "workspace.closed", "workspace.focused",
  "worktree.created", "worktree.opened", "worktree.removed",
  "tab.created", "tab.closed", "tab.focused", "tab.renamed", "tab.moved",
  "pane.created", "pane.closed", "pane.updated", "pane.focused",
  "pane.moved", "pane.exited", "pane.agent_detected",
  "layout.updated",
].map((type) => ({ type }));

let reqSeq = 0;

/** One request / one connection. Resolves with the parsed `result`. */
function herdrRequest(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `office:${++reqSeq}`;
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id, method, params }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      sock.end();
      try {
        const msg = JSON.parse(line);
        if (msg.error) reject(new Error(`${method}: ${msg.error.code} ${msg.error.message}`));
        else resolve(msg.result);
      } catch (err) {
        reject(err);
      }
    });
    // Through a tunnel, a remote Herdr that is down shows up as a connection
    // that closes without a reply.
    sock.on("close", () => reject(new Error(`${method}: no reply from Herdr`)));
    sock.on("error", reject);
  });
}

/**
 * Emits "status" when `state`/`message` change, "snapshot" with a fresh
 * `session.snapshot`, and "event" for every Herdr event.
 * `state`: "connecting" → "live" ⇄ "down" (retries with backoff while down).
 */
export class Machine extends EventEmitter {
  constructor({ id, label, ssh = null, socket = null, remoteSocket = null }) {
    super();
    this.id = id;
    this.label = label;
    this.ssh = ssh;
    this.remoteSocket = remoteSocket;
    this.socketPath = ssh ? path.join(TUNNEL_DIR, `${id}.sock`) : (socket ?? LOCAL_SOCKET);
    this.state = "connecting";
    this.message = ssh ? `ssh ${ssh}…` : "";
    this.snapshot = null;
    this.tunnel = null;
    this.sub = null;
    this.retryTimer = null;
    this.refreshTimer = null;
    this.attempt = 0;
    this.stopped = false;
  }

  get info() {
    return { id: this.id, label: this.label, ssh: this.ssh, state: this.state, message: this.message, version: this.snapshot?.version ?? null };
  }

  /** Settings that go in the config file. */
  get config() {
    const c = { id: this.id, label: this.label };
    if (this.ssh) c.ssh = this.ssh;
    if (this.remoteSocket) c.remoteSocket = this.remoteSocket;
    if (!this.ssh && this.socketPath !== LOCAL_SOCKET) c.socket = this.socketPath;
    return c;
  }

  start() { this.connect(); }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.refreshTimer);
    this.sub?.destroy();
    this.closeTunnel();
  }

  request(method, params) {
    return herdrRequest(this.socketPath, method, params);
  }

  // ------------------------------------------------------------ lifecycle

  async connect() {
    this.retryTimer = null;
    if (this.stopped) return;
    try {
      // A tunnel whose socket is gone carries nothing; start it over.
      if (this.ssh && this.tunnel && !fs.existsSync(this.socketPath)) this.closeTunnel();
      if (this.ssh && !this.tunnel) await this.openTunnel();
      this.subscribe();
    } catch (err) {
      this.fail(err.message);
    }
  }

  /** Mark the floor down and retry. A tunnel failure explains more than the connection drop it causes, so it wins. */
  fail(message, fromTunnel = false) {
    if (this.stopped) return;
    this.sub?.destroy();
    this.sub = null;
    if (this.retryTimer && !fromTunnel) return;
    this.setState("down", message);
    if (this.retryTimer) return;
    const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)];
    console.warn(`[bridge] ${this.label}: ${message}; retrying in ${wait / 1000}s`);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  setState(state, message = "") {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.emit("status", this.info);
  }

  subscribe() {
    const sock = net.createConnection(this.socketPath);
    this.sub = sock;
    let buf = "";
    let answered = false;
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id: "office:sub", method: "events.subscribe", params: { subscriptions: SUBSCRIPTIONS } }) + "\n");
    });
    sock.on("data", (chunk) => {
      if (!answered) {
        answered = true;
        console.log(`[bridge] ${this.label}: subscribed to herdr events`);
        this.scheduleRefresh();
      }
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.error) { console.error(`[bridge] ${this.label}: subscribe error:`, msg.error); continue; }
        if (msg.event) {
          this.emit("event", msg.event, msg.data);
          this.scheduleRefresh();
        }
      }
    });
    const lost = (why) => { if (this.sub === sock) this.fail(why); };
    sock.on("error", (err) => lost(err.code === "ENOENT" || err.code === "ECONNREFUSED" ? `Herdr is not running (${err.code})` : err.message));
    sock.on("close", () => lost(answered ? "Herdr closed the event stream" : `no reply from Herdr${this.ssh ? ` on ${this.ssh}` : ""}`));
  }

  scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((err) => console.error(`[bridge] ${this.label}: snapshot failed:`, err.message));
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /** Fetch a fresh `session.snapshot` now and emit it. */
  async refresh() {
    clearTimeout(this.refreshTimer);
    this.snapshot = (await this.request("session.snapshot")).snapshot;
    this.attempt = 0;
    this.setState("live");
    this.emit("snapshot", this.snapshot);
  }

  // ------------------------------------------------------------ ssh tunnel

  async openTunnel() {
    fs.mkdirSync(TUNNEL_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(TUNNEL_DIR, 0o700); // the tunnel socket reaches a remote shell; keep it ours
    const remote = this.remoteSocket ?? await this.probeRemoteSocket();
    try { fs.unlinkSync(this.socketPath); } catch {}
    // ControlPath=none: with ControlMaster in ~/.ssh/config, `ssh -N -L` would
    // hand the forward to the shared master and exit 0 right away, leaving us
    // nothing to watch or kill. The tunnel gets its own connection instead.
    const child = spawn(SSH, [
      ...SSH_OPTS, "-o", "ControlPath=none", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "StreamLocalBindUnlink=yes",
      "-L", `${this.socketPath}:${remote}`, "--", this.ssh,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    this.tunnel = child;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
    const why = (code, signal) => lastLine(stderr) || (signal ? `killed by ${signal}` : `connection closed (exit ${code})`);

    await new Promise((resolve, reject) => {
      const started = Date.now();
      let settled = false;
      // ssh died before the socket showed up: forget it so the retry spawns a new one.
      const died = (message) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        if (this.tunnel === child) this.closeTunnel();
        reject(new Error(message));
      };
      const poll = setInterval(() => {
        if (fs.existsSync(this.socketPath)) { settled = true; clearInterval(poll); resolve(); }
        else if (Date.now() - started > TUNNEL_READY_MS) died("ssh: timed out opening the tunnel");
      }, 100);
      child.once("exit", (code, signal) => died(`ssh: ${why(code, signal)}`));
      child.once("error", (err) => died(`ssh: ${err.message}`));
    });
    console.log(`[bridge] ${this.label}: tunnel up (${this.socketPath} → ${this.ssh}:${remote})`);
    child.once("exit", (code, signal) => {
      if (this.tunnel !== child) return;
      this.tunnel = null;
      this.fail(`ssh tunnel closed: ${why(code, signal)}`, true);
    });
  }

  closeTunnel() {
    const child = this.tunnel;
    this.tunnel = null;
    child?.kill();
    // Only ever remove our own tunnel socket, never a Herdr socket.
    if (this.ssh) try { fs.unlinkSync(this.socketPath); } catch {}
  }

  probeRemoteSocket() {
    return new Promise((resolve, reject) => {
      execFile(SSH, [...SSH_OPTS, "--", this.ssh, REMOTE_PROBE], { timeout: TUNNEL_READY_MS }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout.trim());
        if (err.code === 3) return reject(new Error(`Herdr is not running on ${this.ssh} (no socket at ${stdout.trim()})`));
        reject(new Error(`ssh: ${lastLine(stderr) || err.message}`));
      });
    });
  }
}

/** Last line ssh printed, without its own "ssh: " prefix. */
export function lastLine(s) {
  return (s.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "").replace(/^ssh: /, "");
}
