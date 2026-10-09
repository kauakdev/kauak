// What the bridge does with each message from a page: one handler per
// ClientMessage type (@kauak/protocol), each given its own message. The map's
// type has a key for every type, so a new message does not compile until it
// has a handler here, as it does not until it has a parser in the protocol.
//
// Bridge.connected (core/bridge.ts) parses each message and calls its
// handler; a message that is not one of these never gets here. Replies go to
// the page that sent it, through its Connection.

import { type ClientMessage, SSH_TARGET } from "@kauak/protocol";
import type { Runtime } from "../ports/runtime.ts";
import type { Connection } from "../transport/ws.ts";
import type { Bridge } from "./bridge.ts";
import { build } from "./build.ts";

type Type = ClientMessage["type"];
/** Each type's message. A map rather than Extract, so that a handler generic in its type still knows its message's fields. */
type Messages = { [T in Type]: Extract<ClientMessage, { type: T }> };
type Message<T extends Type> = Messages[T];

/** What a page's message does, given the page, which any reply goes to, and the bridge. */
type Handler<T extends Type> = (msg: Message<T>, page: Connection, bridge: Bridge) => void | Promise<void>;

/** Every message but add_machine is about one floor, named in `machine`. */
type FloorType = Exclude<Type, "add_machine">;

/** The handler of a message about one floor, given that floor; a message naming a floor that does not exist is dropped. */
function onFloor<T extends FloorType>(
  handle: (m: Runtime, msg: Message<T>, page: Connection, bridge: Bridge) => void | Promise<void>,
): Handler<T> {
  return (msg, page, bridge) => {
    const m = bridge.machines.get(msg.machine);
    if (m) return handle(m, msg, page, bridge);
  };
}

const HANDLERS: { [T in Type]: Handler<T> } = {
  add_machine: (msg, page, bridge) => {
    const ssh = msg.ssh;
    if (!SSH_TARGET.test(ssh)) {
      page.send({ type: "machine_error", message: "Use an SSH host, user@host, or a Host alias from ~/.ssh/config." });
      return;
    }
    if ([...bridge.machines.values()].some((m) => m.ssh === ssh)) {
      page.send({ type: "machine_error", message: `${ssh} already has a floor.` });
      return;
    }
    const label = msg.label || ssh.split("@").pop()!;
    const m = bridge.addMachine({ id: bridge.uniqueId(label), label: label.slice(0, 40), ssh });
    bridge.startMachine(m);
    bridge.saveConfig();
    bridge.broadcastMachines();
    page.send({ type: "machine_added", machine: m.id });
  },

  remove_machine: onFloor((m, _msg, _page, bridge) => {
    if (m.id === "local") return;
    bridge.removeMachine(m);
    bridge.saveConfig();
    bridge.broadcastMachines();
  }),

  focus: onFloor(async (m, msg, page) => {
    try {
      await m.focusPane(msg.pane_id);
    } catch (err) {
      page.send({ type: "error", machine: m.id, message: (err as Error).message });
    }
  }),

  // Terminal view: the pane's screen, or with `lines` the last `lines` rows
  // of its history and screen. Reads run in parallel (each Herdr request
  // takes ~100 ms); `seq` is echoed so the client can drop replies that
  // arrive out of order.
  read: onFloor(async (m, msg, page) => {
    try {
      const text = await m.readPane(msg.pane_id, msg.lines);
      page.send({ type: "pane_output", machine: m.id, pane_id: msg.pane_id, text, seq: msg.seq });
    } catch (err) {
      page.send({ type: "error", machine: m.id, pane_id: msg.pane_id, message: (err as Error).message });
    }
  }),

  // Keystrokes from the browser terminal. `ops` is an ordered list of
  // { text } (literal bytes) and { keys } (named keys such as "enter" or
  // "ctrl+c"), queued per pane (core/input.ts).
  input: onFloor((m, msg, page, bridge) => bridge.input.queue(page, m, msg.pane_id, msg.ops, msg.id)),

  // The message box's "/" menu. The agent and its folder come from the
  // snapshot, not the page; only this machine's files are read.
  commands: onFloor(async (m, msg, page, bridge) => {
    const pane = m.snapshot?.panes.find((p) => p.pane_id === msg.pane_id);
    if (!pane) return;
    const commands = await bridge.deps.commands(pane.agent, pane.cwd, !m.ssh);
    page.send({ type: "commands", machine: m.id, pane_id: msg.pane_id, agent: pane.agent, commands });
  }),

  // A printer's uncommitted view. Only checkouts a room is in are read (the floor's Printers).
  uncommitted: onFloor(async (m, msg, page, bridge) => {
    const uncommitted = await bridge.enriched.get(m.id)!.printers.uncommitted(msg.root);
    page.send({ type: "uncommitted", machine: m.id, root: msg.root, id: msg.id, ...uncommitted });
  }),

  refresh: onFloor((m) => m.scheduleRefresh()),

  // Build mode (core/build.ts).
  create_desk: onFloor((m, msg, page) => build(page, m, msg)),
  create_room: onFloor((m, msg, page) => build(page, m, msg)),
};

/** Runs the handler for the message's type. */
export function handle(msg: ClientMessage, page: Connection, bridge: Bridge) {
  return run(msg.type, msg, page, bridge);
}

// Generic in the type, so TypeScript sees that the handler it picks takes this message.
function run<T extends Type>(type: T, msg: Message<T>, page: Connection, bridge: Bridge) {
  return HANDLERS[type](msg, page, bridge);
}
