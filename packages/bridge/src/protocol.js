// The Kauak protocol's rules: what a page may send the bridge. The types are
// in protocol.d.ts and the reference is docs/protocol.md. Every message from a
// page goes through parseClientMessage before the bridge acts on it; a message
// that is not one of these shapes is dropped. Rules that deserve an answer
// (an SSH target or a branch name typed in a form) are only exported here: the
// bridge checks them itself and replies with what is wrong.
//
// Like the types, none of this belongs to the runtime behind a floor.

export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"];

// An SSH destination as typed in the UI: `host`, `user@host` or an alias from
// ~/.ssh/config. Never starting with "-", so it cannot be read as an ssh option.
export const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@-]{0,127}$/;
// A branch or base as typed in the build form, never starting with "-".
export const GIT_REF = /^[A-Za-z0-9_.][A-Za-z0-9_./-]{0,199}$/;
// An agent kind: its command's name ("claude", "codex"...).
export const AGENT_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
// A named key: "enter", "esc", "tab", "backspace", an arrow, or a letter or
// digit, after any of the ctrl+, alt+ and shift+ modifiers ("ctrl+c", "shift+tab").
export const KEY = /^(?:(?:ctrl|alt|shift)\+){0,3}(?:enter|esc|tab|backspace|up|down|left|right|[a-z0-9])$/;

// The most rows one read may ask for, ops in one input message, and characters in one text op.
export const MAX_READ_LINES = 5000;
export const MAX_INPUT_OPS = 256;
export const MAX_INPUT_TEXT = 64 * 1024;

// Ids, and text fields (paths, labels, branches) the bridge checks further itself.
const MAX_ID = 512;
const MAX_FIELD = 4096;

/** A page's message as the bridge acts on it (ClientMessage in protocol.d.ts), or null when it is not one. */
export function parseClientMessage(value) {
  if (!isObject(value) || typeof value.type !== "string") return null;
  const m = value;
  const id = Number.isInteger(m.id) ? { id: m.id } : {};
  switch (m.type) {
    case "add_machine":
      if (!str(m.ssh, MAX_FIELD, true)) return null;
      return { type: m.type, ssh: m.ssh.trim(), label: str(m.label, MAX_FIELD) ? m.label.trim() : "" };
    case "remove_machine":
    case "refresh":
      return str(m.machine) ? { type: m.type, machine: m.machine } : null;
  }
  // Everything else is about something on one floor.
  if (!str(m.machine)) return null;
  const machine = m.machine;
  switch (m.type) {
    case "focus":
    case "commands":
      return str(m.pane_id) ? { type: m.type, machine, pane_id: m.pane_id } : null;
    case "read": {
      if (!str(m.pane_id)) return null;
      const lines = Number.isInteger(m.lines) && m.lines > 0 ? Math.min(m.lines, MAX_READ_LINES) : null;
      return { type: m.type, machine, pane_id: m.pane_id, lines, ...(typeof m.seq === "number" ? { seq: m.seq } : {}) };
    }
    case "input":
      if (!str(m.pane_id) || !Array.isArray(m.ops)) return null;
      return { type: m.type, machine, pane_id: m.pane_id, ops: inputOps(m.ops), ...id };
    case "uncommitted":
      return str(m.root, MAX_FIELD) ? { type: m.type, machine, root: m.root, ...id } : null;
    case "create_desk":
      if (!str(m.workspace_id)) return null;
      return { type: m.type, machine, workspace_id: m.workspace_id, agent: agentOf(m.agent), ...id };
    case "create_room": {
      const room = roomSpec(m.room);
      return room ? { type: m.type, machine, room, agent: agentOf(m.agent), ...id } : null;
    }
  }
  return null;
}

/** Text ops cut to MAX_INPUT_TEXT, keys that are not KEY names dropped, empty ops left out. */
function inputOps(list) {
  const ops = [];
  for (const op of list.slice(0, MAX_INPUT_OPS)) {
    if (typeof op?.text === "string") {
      if (op.text) ops.push({ text: op.text.slice(0, MAX_INPUT_TEXT) });
    } else if (Array.isArray(op?.keys)) {
      const keys = op.keys.filter((k) => typeof k === "string" && KEY.test(k));
      if (keys.length) ops.push({ keys });
    }
  }
  return ops;
}

/** The agent to start: any non-empty string, which the bridge checks against AGENT_KIND (and says so); null for none. */
function agentOf(v) {
  return typeof v === "string" && v ? v.slice(0, 64) : null;
}

/** A build-mode room as sent; the bridge checks the folder and branch itself. */
function roomSpec(r) {
  if (!isObject(r) || !str(r.cwd, MAX_FIELD, true) || (r.label !== undefined && !str(r.label, MAX_FIELD, true))) return null;
  const label = typeof r.label === "string" ? { label: r.label } : {};
  if (r.kind === "folder") return { kind: r.kind, cwd: r.cwd, ...label };
  if (r.kind !== "worktree" || !str(r.branch, MAX_FIELD, true) || (r.base !== undefined && !str(r.base, MAX_FIELD, true))) return null;
  return { kind: r.kind, cwd: r.cwd, branch: r.branch, ...(typeof r.base === "string" ? { base: r.base } : {}), ...label };
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A string of at most `max` characters, empty only when `empty`. */
function str(v, max = MAX_ID, empty = false) {
  return typeof v === "string" && v.length <= max && (empty || v.length > 0);
}
