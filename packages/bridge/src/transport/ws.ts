// How pages reach the bridge: one HTTP server that serves the built office
// page (config.pageDir, `pnpm build`), so `npx kauak serve` is one process and
// one URL, and the WebSocket the pages connect to, on the same port. `pnpm
// dev` serves the page from Vite instead. Beside the page it serves the
// appearance packages installed on this machine, as /appearances.json
// (appearances.ts), to a page from Vite too.
//
// Of the Kauak protocol it knows only that what goes to a page is a
// BridgeMessage, sent as JSON. What a page says is the core's to read
// (core/bridge.ts), and the core sees a page only as a Connection.
//
// Making it opens nothing: `listen()` opens the port and `close()` closes it.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BridgeMessage } from "@kauak/protocol";
import { WebSocketServer } from "ws";
import type { BridgeConfig } from "../config.ts";
import { readAppearances } from "./appearances.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** What the transport uses of the bridge's config: where it listens, which pages may connect, the page, the appearance packages. */
export type TransportSettings = Pick<BridgeConfig, "port" | "host" | "origins" | "pageDir" | "appearanceDir" | "appearanceFiles">;

/** Where the page asks for the appearance packages installed on this machine. */
export const APPEARANCES_PATH = "/appearances.json";

/** A page, as the core sees it: what it may be sent is a BridgeMessage, so the compiler checks every message against the protocol. */
export interface Connection {
  send(msg: BridgeMessage): void;
}

/** A page connected: the core sends it what it needs first, and returns what to do with each message from it. */
export type Connected = (page: Connection) => (data: string) => void;

/** The HTTP server, the page it serves and the WebSocket on it. */
export class WsServer {
  settings: TransportSettings;
  /** The built page's folder, ending in a separator so nothing beside it can pass for a file in it; null for none. */
  pageDir: string | null;
  hasPage: boolean;
  allowedOrigins: Set<string>;
  server: http.Server;
  wss: WebSocketServer;

  constructor(settings: TransportSettings, connected: Connected) {
    this.settings = settings;
    this.pageDir = settings.pageDir === null ? null : path.resolve(settings.pageDir) + path.sep;
    this.hasPage = this.pageDir !== null && fs.existsSync(path.join(this.pageDir, "index.html"));
    this.allowedOrigins = new Set(settings.origins);
    this.server = http.createServer((req, res) => this.servePage(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      // Browsers let any web page open a WebSocket to 127.0.0.1; only accept our own page.
      verifyClient: ({ origin }: { origin: string }) => !origin || this.ours(origin), // no origin: not a browser
    });
    this.wss.on("connection", (ws) => {
      console.log(`[bridge] client connected (${this.wss.clients.size})`);
      const received = connected({ send: (msg) => ws.send(JSON.stringify(msg)) });
      ws.on("message", (raw) => received(raw.toString()));
    });
  }

  /** Whether a page at this URL is ours: its hostname is this computer's, or one KAUAK_ORIGINS adds. */
  ours(url: string) {
    try {
      return this.allowedOrigins.has(new URL(url).hostname);
    } catch {
      return false;
    }
  }

  /** Static files from the built page, which are not secret, and the installed appearances, which only our own pages get. */
  servePage(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return res.writeHead(400).end();
    }
    if (rel.endsWith("/")) rel += "index.html";
    if (rel === APPEARANCES_PATH) {
      this.serveAppearances(req, res).catch(() => res.headersSent || res.writeHead(500).end());
      return;
    }
    const notFound = () => {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(this.hasPage ? "Not found\n" : "The office page is not built. Run `pnpm build`, or `pnpm dev` for the Vite dev server.\n");
    };
    if (this.pageDir === null) return notFound();
    const file = path.resolve(this.pageDir, `.${rel}`);
    if (!file.startsWith(this.pageDir)) return res.writeHead(404).end();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        "content-length": st.size,
        // Vite puts a content hash in every asset name; index.html must always be fresh.
        "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  /**
   * The appearance packages installed on this machine, read now, so an edited
   * file shows on reload. They carry this machine's paths and whatever the
   * files hold, so they are answered only under a name the WebSocket accepts
   * a page from: a site that points its own name at 127.0.0.1 (DNS rebinding)
   * is refused. A HEAD reads nothing.
   */
  async serveAppearances(req: http.IncomingMessage, res: http.ServerResponse) {
    const { host, origin } = req.headers;
    if (!host || !this.ours(`http://${host}`) || (origin !== undefined && !this.ours(origin))) return res.writeHead(403).end();
    const headers = { "content-type": "application/json", "cache-control": "no-cache", "x-content-type-options": "nosniff" };
    if (req.method === "HEAD") return res.writeHead(200, headers).end();
    const body = JSON.stringify(await readAppearances(this.settings));
    res.writeHead(200, { ...headers, "content-length": Buffer.byteLength(body) }).end(body);
  }

  /** To every page connected, encoded once. */
  broadcast(msg: BridgeMessage) {
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) if (client.readyState === 1) client.send(data);
  }

  /**
   * Opens the port. Resolves with the WebSocket's address and the office's
   * URL, null when there is no built page; rejects when the port cannot be
   * opened, after saying why.
   */
  listen() {
    const { port, host } = this.settings;
    return new Promise<{ address: string; page: string | null }>((resolve, reject) => {
      // ws re-emits the HTTP server's errors (EADDRINUSE…) on the WebSocket server.
      this.wss.once("error", (err: NodeJS.ErrnoException) => {
        console.error(
          err.code === "EADDRINUSE"
            ? `[bridge] port ${port} is already in use. Is the office already running? Pick another port with --port or KAUAK_PORT.`
            : `[bridge] cannot listen on ${host}:${port}: ${err.message}`,
        );
        reject(err);
      });
      this.server.listen(port, host, () => {
        const shown = host.includes(":") ? `[${host}]` : host;
        resolve({
          address: `ws://${shown}:${port}`,
          page: this.hasPage ? `http://${shown === "0.0.0.0" || shown === "[::]" ? "127.0.0.1" : shown}:${port}/` : null,
        });
      });
    });
  }

  /** Drops every page and closes the port. */
  close() {
    for (const ws of this.wss.clients) ws.terminate();
    return new Promise<void>((resolve) => {
      this.wss.close();
      // Resolves on an error too: a port that never opened has nothing to close.
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
