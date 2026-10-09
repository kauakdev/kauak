// Build mode: new desks (a new tab in a room) and new rooms (a workspace in a
// folder, or a git worktree on a new branch), each with an optional agent.
// `created` goes out as soon as the pane exists, after a fresh snapshot, so
// the page can open it right away; the agent starts afterwards (Herdr waits
// until it is ready, which can take seconds), and a failure there is a
// `create_error` that carries the pane id.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_KIND, type ClientMessage, GIT_REF, type RoomSpec } from "@kauak/protocol";
import type { Runtime } from "../ports/runtime.ts";
import type { Connection } from "../transport/ws.ts";

/**
 * A page's new desk or room, then its agent. The replies keep the key order
 * they have always had, `machine` and `id` first, so the JSON a page gets is
 * the same.
 */
export async function build(page: Connection, m: Runtime, msg: Extract<ClientMessage, { type: "create_desk" | "create_room" }>) {
  const agent = msg.agent;
  let paneId: string;
  try {
    if (agent && !AGENT_KIND.test(agent)) throw new Error(`Unknown agent kind "${agent}".`);
    paneId = msg.type === "create_desk" ? await m.createDesk(msg.workspace_id) : await m.createRoom(roomSpec(m, msg.room));
    await m.refresh();
  } catch (err) {
    page.send({ machine: m.id, id: msg.id, type: "create_error", message: (err as Error).message });
    return;
  }
  page.send({ machine: m.id, id: msg.id, type: "created", pane_id: paneId });
  if (!agent) return;
  try {
    await m.startAgent(agent, paneId);
  } catch (err) {
    const message = `The desk is ready, but ${agent} did not start: ${(err as Error).message}`;
    page.send({ machine: m.id, id: msg.id, type: "create_error", pane_id: paneId, message });
  }
}

/** A room from the build form, checked: its folder (see roomPath), branch, base and label. */
function roomSpec(m: Runtime, room: RoomSpec): RoomSpec {
  const cwd = roomPath(m, room.cwd);
  const label = room.label?.trim() ? room.label.trim().slice(0, 60) : undefined;
  if (room.kind === "folder") return { kind: "folder", cwd, label };
  const branch = room.branch.trim();
  const base = room.base?.trim() || undefined;
  if (!GIT_REF.test(branch)) throw new Error("Enter a branch name like feat/my-change.");
  if (base && !GIT_REF.test(base)) throw new Error(`"${base}" is not a branch or commit.`);
  return { kind: "worktree", cwd, branch, base, label };
}

/**
 * The folder a new room opens in. Herdr neither expands `~` nor rejects a
 * missing folder (it opens the home directory instead), so this machine's
 * paths are expanded and checked here; a remote one needs an absolute path.
 */
function roomPath(m: Runtime, raw: string) {
  let p = raw.trim();
  if (!p || p.length > 1024) throw new Error("Enter a folder.");
  if (!m.ssh && (p === "~" || p.startsWith("~/"))) p = path.join(os.homedir(), p.slice(1));
  if (!p.startsWith("/")) throw new Error(`Use an absolute path${m.ssh ? ` on ${m.label}` : ""}, like /home/you/code/project.`);
  if (!m.ssh && !fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`There is no folder at ${p}.`);
  return p;
}
