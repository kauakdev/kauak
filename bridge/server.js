// Bridge between the Herdr unix socket and browser WebSocket clients.
//
// Herdr protocol (v0.9.x, protocol 22):
//   - newline-delimited JSON over a unix socket
//   - one request per connection; the server closes after the response
//   - `events.subscribe` is the exception: the connection stays open and streams
//     `{"event": "...", "data": {...}}` envelopes
//
// The bridge keeps things simple and robust: on every event it re-fetches the
// full `session.snapshot` (a few KB) and broadcasts it to all clients.

import net from "node:net";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const SOCKET_PATH =
  process.env.HERDR_SOCKET ?? path.join(os.homedir(), ".config", "herdr", "herdr.sock");
const WS_PORT = Number(process.env.AGENT_OFFICE_PORT ?? 7788);
const SNAPSHOT_DEBOUNCE_MS = 80;

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
function herdrRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `office:${++reqSeq}`;
    const sock = net.createConnection(SOCKET_PATH);
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
    sock.on("error", reject);
  });
}

async function fetchSnapshot() {
  const res = await herdrRequest("session.snapshot");
  return res.snapshot;
}

// ---------------------------------------------------------------- WS server

const wss = new WebSocketServer({ port: WS_PORT });
let lastSnapshot = null;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      lastSnapshot = await fetchSnapshot();
      broadcast({ type: "snapshot", snapshot: lastSnapshot });
    } catch (err) {
      console.error("[bridge] snapshot failed:", err.message);
      broadcast({ type: "herdr_down", message: err.message });
    }
  }, SNAPSHOT_DEBOUNCE_MS);
}

wss.on("connection", async (ws) => {
  console.log(`[bridge] client connected (${wss.clients.size})`);
  try {
    if (!lastSnapshot) lastSnapshot = await fetchSnapshot();
    ws.send(JSON.stringify({ type: "snapshot", snapshot: lastSnapshot }));
  } catch (err) {
    ws.send(JSON.stringify({ type: "herdr_down", message: err.message }));
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "focus" && typeof msg.pane_id === "string") {
      try {
        await herdrRequest("pane.focus", { pane_id: msg.pane_id });
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
      }
    } else if (msg.type === "read" && typeof msg.pane_id === "string") {
      // Read-only terminal view. `visible` = the pane's rendered viewport.
      try {
        const res = await herdrRequest("pane.read", {
          pane_id: msg.pane_id,
          source: msg.source ?? "visible",
          format: "ansi",
          strip_ansi: false,
          lines: msg.lines ?? null,
        });
        ws.send(JSON.stringify({
          type: "pane_output",
          pane_id: msg.pane_id,
          text: res.read.text,
          revision: res.read.revision,
          truncated: res.read.truncated,
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", pane_id: msg.pane_id, message: err.message }));
      }
    } else if (msg.type === "input" && typeof msg.pane_id === "string" && Array.isArray(msg.ops)) {
      // Keystrokes from the browser terminal. `ops` is an ordered list of
      // { text } (literal bytes, pane.send_text) and { keys } (named keys such
      // as "enter" or "ctrl+c", pane.send_keys). Per-pane queue keeps order.
      const paneId = msg.pane_id;
      const ops = msg.ops.slice(0, MAX_INPUT_OPS);
      enqueueInput(paneId, async () => {
        try {
          for (const op of ops) {
            if (typeof op.text === "string" && op.text.length > 0) {
              await herdrRequest("pane.send_text", { pane_id: paneId, text: op.text.slice(0, MAX_INPUT_TEXT) });
            } else if (Array.isArray(op.keys) && op.keys.length > 0) {
              const keys = op.keys.filter((k) => typeof k === "string" && k.length <= 24).slice(0, 64);
              if (keys.length) await herdrRequest("pane.send_keys", { pane_id: paneId, keys });
            }
          }
          ws.send(JSON.stringify({ type: "input_ack", pane_id: paneId }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", pane_id: paneId, message: err.message }));
        }
      });
    } else if (msg.type === "refresh") {
      scheduleRefresh();
    }
  });
});

// Serialize input per pane so fast typing cannot reorder across connections.
const MAX_INPUT_OPS = 256;
const MAX_INPUT_TEXT = 64 * 1024;
const inputQueues = new Map();
function enqueueInput(paneId, job) {
  const prev = inputQueues.get(paneId) ?? Promise.resolve();
  const next = prev.then(job, job).finally(() => { if (inputQueues.get(paneId) === next) inputQueues.delete(paneId); });
  inputQueues.set(paneId, next);
}

// ---------------------------------------------------------------- event stream

function subscribe() {
  const sock = net.createConnection(SOCKET_PATH);
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("connect", () => {
    console.log(`[bridge] subscribed to herdr events at ${SOCKET_PATH}`);
    sock.write(JSON.stringify({
      id: "office:sub",
      method: "events.subscribe",
      params: { subscriptions: SUBSCRIPTIONS },
    }) + "\n");
    scheduleRefresh();
  });
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.error) { console.error("[bridge] subscribe error:", msg.error); continue; }
      if (msg.event) {
        broadcast({ type: "event", event: msg.event, data: msg.data });
        scheduleRefresh();
      }
    }
  });
  const retry = (why) => {
    console.warn(`[bridge] event stream ${why}; retrying in 2s`);
    broadcast({ type: "herdr_down", message: why });
    setTimeout(subscribe, 2000);
  };
  sock.on("error", (err) => retry(err.message));
  sock.on("close", () => retry("closed"));
}

subscribe();
console.log(`[bridge] websocket listening on ws://localhost:${WS_PORT}`);
