// A stand-in Herdr server for tests: a unix socket that speaks Herdr's
// protocol as machine.ts expects it (newline-delimited JSON, one request per
// connection, `events.subscribe` kept open) and answers from a fixture.
// herdr-snapshot.json is a real 0.9.3 `session.snapshot`, scrubbed.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const FIXTURE = JSON.parse(fs.readFileSync(new URL("./herdr-snapshot.json", import.meta.url), "utf8"));

/**
 * Starts a fake Herdr on a fresh socket. `handlers` answer methods by name
 * (params → result, or throw an error with a `code` for Herdr's error reply);
 * `session.snapshot` answers with `snapshot` and anything else with {}.
 * `requests` lists every request but the subscription, in order.
 */
export async function fakeHerdr({ snapshot = FIXTURE, handlers = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-fake-herdr-"));
  const socketPath = path.join(dir, "herdr.sock");
  const requests = [];
  const subscribers = new Set();
  const fake = {
    socketPath,
    requests,
    snapshot,
    /** Send an event to every subscriber. */
    emit(event, data = {}) {
      for (const sock of subscribers) sock.write(`${JSON.stringify({ event, data })}\n`);
    },
    /** The requests made for one method, in order. */
    calls(method) {
      return requests.filter((r) => r.method === method).map((r) => r.params);
    },
    async close() {
      for (const sock of subscribers) sock.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  const server = net.createServer((sock) => {
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    sock.on("data", async (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      buf = "";
      if (req.method === "events.subscribe") {
        subscribers.add(sock);
        sock.on("close", () => subscribers.delete(sock));
        sock.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
        return;
      }
      requests.push({ method: req.method, params: req.params });
      let reply;
      try {
        const handler = handlers[req.method] ?? (() => (req.method === "session.snapshot" ? { snapshot: fake.snapshot } : {}));
        reply = { id: req.id, result: await handler(req.params) };
      } catch (err) {
        reply = { id: req.id, error: { code: err.code ?? "internal_error", message: err.message } };
      }
      sock.end(`${JSON.stringify(reply)}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return fake;
}

/** An error the fake answers with, as Herdr would: `{ code, message }`. */
export function herdrError(code, message) {
  return Object.assign(new Error(message), { code });
}
