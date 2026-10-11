// A client for T3 Code's WebSocket API: Effect RPC (effect/unstable/rpc) with
// its JSON serialization, as T3 Code 0.0.45 serves it on `/ws`. Each frame is
// one message or an array of them:
//
//   to the server     {_tag: "Request", id, tag, payload, headers: []}, {_tag: "Ack", requestId},
//                     {_tag: "Interrupt", requestId}, {_tag: "Ping"}
//   from the server   {_tag: "Chunk", requestId, values}, {_tag: "Exit", requestId, exit},
//                     {_tag: "Pong"}, {_tag: "Defect", defect}
//
// A request either answers once (`Exit` with `{_tag: "Success", value}` or
// `{_tag: "Failure", cause}`) or streams `Chunk`s until its `Exit`. The server
// sends the next chunk of a stream only once the last one is acknowledged, so
// every chunk gets an `Ack`, or the stream stalls.
//
// T3-specific, but nothing here names an orchestration method: floor.ts does.

import { EventEmitter } from "node:events";
import WebSocket from "ws";

const PING_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** A request that failed: T3's error, or the connection's. `tag` is the error's `_tag` when T3 sent one. */
export type RpcError = Error & { tag?: string };

interface Pending {
  resolve(value: unknown): void;
  reject(err: RpcError): void;
  /** Set on a stream: each chunk's values, in order. */
  onChunk?: (values: unknown[]) => void;
}

/** A stream request; `close()` interrupts it. `done` settles when the server ends it or the connection drops. */
export interface RpcStream {
  done: Promise<void>;
  close(): void;
}

/**
 * One WebSocket to a T3 server. Emits "close" with a message fit to show
 * once it is gone, whoever closed it; every request still waiting is
 * rejected with that message.
 */
export class RpcSocket extends EventEmitter {
  private ws: WebSocket;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private pinger: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private constructor(ws: WebSocket) {
    super();
    this.ws = ws;
  }

  /** Opens `/ws` with the bearer token; rejects with a message fit to show. */
  static open(url: string, token: string): Promise<RpcSocket> {
    const wsUrl = new URL("/ws", url);
    wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: CONNECT_TIMEOUT_MS });
    return new Promise((resolve, reject) => {
      ws.once("unexpected-response", (_req, res) => {
        ws.terminate();
        reject(new Error(res.statusCode === 401 ? "T3 Code refused the token (401)" : `T3 Code answered ${res.statusCode}`));
      });
      ws.once("error", (err: NodeJS.ErrnoException) =>
        reject(new Error(err.code === "ECONNREFUSED" ? "T3 Code is not running (ECONNREFUSED)" : err.message)),
      );
      ws.once("open", () => {
        ws.removeAllListeners("error");
        ws.removeAllListeners("unexpected-response");
        const socket = new RpcSocket(ws);
        socket.listen();
        resolve(socket);
      });
    });
  }

  private listen() {
    this.ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) this.receive(msg);
    });
    this.ws.on("close", (code, reason) => this.shut(`T3 Code closed the connection (${code}${reason.length ? `: ${reason}` : ""})`));
    this.ws.on("error", (err) => this.shut(err.message));
    this.pinger = setInterval(() => {
      this.send({ _tag: "Ping" });
      this.pongTimer ??= setTimeout(() => {
        this.shut("T3 Code stopped answering");
        this.ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  private receive(msg: { _tag?: string; requestId?: string; values?: unknown[]; exit?: RpcExit; defect?: unknown }) {
    if (msg._tag === "Pong") {
      clearTimeout(this.pongTimer as NodeJS.Timeout);
      this.pongTimer = null;
      return;
    }
    if (msg._tag === "Defect") {
      console.error("[bridge] T3 Code reported a defect:", msg.defect);
      return;
    }
    const id = String(msg.requestId ?? "");
    const p = this.pending.get(id);
    if (!p) return;
    if (msg._tag === "Chunk") {
      p.onChunk?.(Array.isArray(msg.values) ? msg.values : []);
      this.send({ _tag: "Ack", requestId: id });
    } else if (msg._tag === "Exit") {
      this.pending.delete(id);
      const exit = msg.exit;
      if (exit?._tag === "Success") p.resolve(exit.value);
      else p.reject(failure(exit?.cause));
    }
  }

  private send(msg: object) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Sends the request; its id, or null when the connection is gone (and `p` is rejected). */
  private start(tag: string, payload: unknown, p: Pending): string | null {
    if (this.closed) {
      p.reject(new Error("not connected to T3 Code"));
      return null;
    }
    const id = String(++this.seq);
    this.pending.set(id, p);
    this.send({ _tag: "Request", id, tag, payload, headers: [] });
    return id;
  }

  /** A request that answers once. */
  request<T = unknown>(tag: string, payload: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => this.start(tag, payload, { resolve: resolve as (v: unknown) => void, reject }));
  }

  /** A stream request: `onChunk` gets each chunk's values, in order. */
  stream(tag: string, payload: unknown, onChunk: (values: unknown[]) => void): RpcStream {
    let id: string | null = null;
    const done = new Promise<void>((resolve, reject) => {
      id = this.start(tag, payload, { resolve: () => resolve(), reject, onChunk });
    });
    return {
      done,
      close: () => {
        if (id && this.pending.delete(id)) this.send({ _tag: "Interrupt", requestId: id });
      },
    };
  }

  /** Close the connection; what is still waiting is rejected. */
  close() {
    this.shut("closed");
    this.ws.close();
  }

  private shut(message: string) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger as NodeJS.Timeout);
    clearTimeout(this.pongTimer as NodeJS.Timeout);
    const err = new Error(message);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.emit("close", message);
  }
}

interface RpcExit {
  _tag?: string;
  value?: unknown;
  cause?: unknown;
}

/**
 * A failed exit's cause as an error. The cause is a list of reasons: `Fail`
 * with T3's error (a tagged object with a `message`), `Die` with a defect, or
 * `Interrupt`.
 */
function failure(cause: unknown): RpcError {
  const reasons = Array.isArray(cause) ? cause : [];
  const fail = reasons.find((r) => r?._tag === "Fail")?.error;
  if (fail && typeof fail === "object") {
    const message = typeof fail.message === "string" && fail.message ? fail.message : String(fail._tag ?? "T3 Code refused");
    return Object.assign(new Error(message), { tag: typeof fail._tag === "string" ? fail._tag : undefined });
  }
  if (reasons.some((r) => r?._tag === "Interrupt")) return new Error("interrupted");
  const die = reasons.find((r) => r?._tag === "Die")?.defect;
  return new Error(typeof die === "string" ? die : (die?.message ?? "T3 Code failed the request"));
}
