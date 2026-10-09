// Keystrokes from the browser terminals, to the floors' panes.
//
// Input is serialized per pane so fast typing cannot reorder across
// connections. Every Herdr request takes ~100 ms, so keystrokes that arrive
// while a batch is in flight are merged into the next one ("hello" typed fast
// becomes one send_text). `input_ack` carries the id of the last message sent.
// The ops come checked and trimmed from parseClientMessage.

import { type InputOp, MAX_INPUT_TEXT } from "@kauak/protocol";
import type { Runtime } from "../ports/runtime.ts";
import type { Connection } from "../transport/ws.ts";

/** Ops for one pane from one connection, merged while they wait; `id` is the last message's. */
interface InputBatch {
  page: Connection;
  ops: InputOp[];
  id: number | undefined;
}

/** One per bridge, for every floor and page. */
export class InputQueue {
  /** "machine/pane" → promise chain (see queue) */
  queues: Map<string, Promise<void>>;
  /** "machine/pane" → batch still waiting for its turn */
  openBatches: Map<string, InputBatch>;

  constructor() {
    this.queues = new Map();
    this.openBatches = new Map();
  }

  /** Runs `job` after every job before it with the same key, whether they failed or not. */
  enqueue(key: string, job: () => Promise<void>) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(job, job).finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    });
    this.queues.set(key, next);
  }

  /** `ops` for the pane, merged into this page's batch for it when one is still waiting for its turn. */
  queue(page: Connection, machine: Runtime, paneId: string, ops: InputOp[], id: number | undefined) {
    const key = `${machine.id}/${paneId}`;
    let batch = this.openBatches.get(key);
    if (!batch || batch.page !== page) {
      batch = { page, ops: [], id };
      this.openBatches.set(key, batch);
      const b = batch;
      this.enqueue(key, async () => {
        if (this.openBatches.get(key) === b) this.openBatches.delete(key); // closed to merging once it runs
        try {
          for (const op of b.ops) {
            if ("text" in op) await machine.sendText(paneId, op.text);
            else await machine.sendKeys(paneId, op.keys);
          }
          b.page.send({ type: "input_ack", machine: machine.id, pane_id: paneId, id: b.id });
        } catch (err) {
          b.page.send({ type: "error", machine: machine.id, pane_id: paneId, id: b.id, message: (err as Error).message });
        }
      });
    }
    batch.id = id;
    for (const op of ops) {
      const last = batch.ops[batch.ops.length - 1];
      if ("text" in op) {
        if (last && "text" in last && last.text.length + op.text.length <= MAX_INPUT_TEXT) last.text += op.text;
        else batch.ops.push({ text: op.text });
      } else if (last && "keys" in last) last.keys.push(...op.keys);
      else batch.ops.push({ keys: [...op.keys] });
    }
  }
}
