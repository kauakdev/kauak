// A helper script on a remote floor, for the parts of the bridge that have to
// run where the files are (context_remote.py, diffs_remote.py). The bridge
// starts it over SSH with the machine's python3 (`python3 -c ...`, so nothing
// is installed there), keeps it running, and talks to it in JSON lines:
// {"id", ...request} in, {"id", "result"} out, answered in order.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import fs from "node:fs";
import { SSH, SSH_OPTS, lastLine } from "./machine.ts";

// The first answer waits for the SSH connection.
const TIMEOUT_MS = 20_000;
// After the script dies: 30 s, or 5 min when python3 is missing there.
const RETRY_MS = 30_000;
const NO_PYTHON_RETRY_MS = 5 * 60_000;

/** The floor a script runs on: the part of its Machine this file uses, which the trackers hand on as they got it. */
interface Floor {
  readonly label: string;
  /** Set here: only a remote floor runs a script. */
  readonly ssh: string | null;
}

export class RemoteScript {
  m: Floor;
  what: string;
  command: string;
  child: ChildProcessWithoutNullStreams | null;
  buf: string;
  stderr: string;
  seq: number;
  /** request id → resolve */
  waiting: Map<number, (result: unknown) => void>;
  retryAt: number;
  stopped: boolean;

  /** `file`: the script, beside this one; `what`: what stops working when it dies, for the log. */
  constructor(machine: Floor, file: string, what: string) {
    this.m = machine;
    this.what = what;
    const script = fs.readFileSync(new URL(file, import.meta.url)).toString("base64");
    this.command = `python3 -u -c "import base64; exec(base64.b64decode('${script}'))"`;
    this.child = null;
    this.buf = "";
    this.stderr = "";
    this.seq = 0;
    this.waiting = new Map();
    this.retryAt = 0;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  /** The script's answer, or null when it is not running or did not answer within `timeout` ms. */
  call<T>(request: object, timeout = TIMEOUT_MS): Promise<T | null> {
    if (this.stopped) return Promise.resolve(null);
    if (!this.child) {
      if (Date.now() < this.retryAt) return Promise.resolve(null);
      this.start();
    }
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        this.child?.kill(); // stuck: start over next time
        resolve(null);
      }, timeout);
      this.waiting.set(id, (result) => {
        clearTimeout(timer);
        resolve(result as T | null);
      });
      this.child!.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  start() {
    // ControlPath=none, as for the tunnel: a connection of its own, never handed to a shared master.
    const child = spawn(SSH, [...SSH_OPTS, "-o", "ControlPath=none", "--", this.m.ssh!, this.command], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.buf = "";
    this.stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdin.on("error", () => {}); // EPIPE once it is gone; "exit" says why
    child.stdout.on("data", (chunk) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        let msg: { id: number; result?: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const done = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        done?.(msg.result ?? null);
      }
    });
    child.stderr.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    const gone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child !== child) return;
      this.child = null;
      for (const done of this.waiting.values()) done(null);
      this.waiting.clear();
      if (this.stopped) return;
      const noPython = code === 127;
      this.retryAt = Date.now() + (noPython ? NO_PYTHON_RETRY_MS : RETRY_MS);
      const why = noPython ? "python3 is not installed there" : lastLine(this.stderr) || (signal ? `killed by ${signal}` : `exit ${code}`);
      console.warn(`[bridge] ${this.m.label}: ${this.what} stopped (${why}); retrying in ${(this.retryAt - Date.now()) / 1000}s`);
    };
    child.once("exit", gone);
    child.once("error", (err) => {
      this.stderr += err.message;
      gone(null, null);
    });
  }
}
