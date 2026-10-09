# The Kauak protocol

The office page and the bridge talk over one WebSocket, in JSON messages with
a `type`. That conversation is the Kauak protocol. It belongs to Kauak, not to
the terminal multiplexer behind a floor: the page never sees a Herdr method,
field, event or error, and could show any runtime that the bridge can
translate.

```
Herdr (a unix socket on each machine; over an SSH tunnel for a remote floor)
  │   Herdr's API: session.snapshot, events.subscribe, pane.read, tab.create…
  ▼
packages/bridge/src/runtimes/herdr/ (machine.ts + herdr.ts)    the Herdr adapter, one Machine per floor
  │   Kauak terms, the Runtime port: machine.info, machine.snapshot, readPane, createRoom…
  ▼
packages/bridge/src/core/ (with the enrichers in enrichers/)
  │   the Kauak protocol (packages/protocol) over the WebSocket (transport/ws.ts)
  ▼
packages/web/src/bridge/ws.ts → the office    packages/web/src/bridge/demo.ts speaks it too, with no bridge at all
```

## Where things live

| File | What it knows |
|---|---|
| `packages/protocol/src/index.ts` (`@kauak/protocol`) | The protocol's types: every message both ways, and the snapshot. And its rules: `parseClientMessage` checks and trims every message from a page before the bridge acts on it, and drops anything else (a page message type without a parser does not compile). Also the shared limits and patterns (key names, SSH targets, branch names, agent kinds). It imports nothing: the bridge imports it, and the page its types. |
| `packages/bridge/src/runtimes/herdr/herdr.ts` | Herdr → Kauak, as pure functions: a `session.snapshot` becomes a Kauak snapshot, Herdr's errors become messages fit to show, the agent session Herdr's hooks reported for a pane. |
| `packages/bridge/src/runtimes/herdr/machine.ts` | One Herdr server: its socket protocol, the SSH tunnel, the event subscription, and the Kauak-level operations below, each made of Herdr requests. It implements the `Runtime` port. |
| `packages/bridge/src/ports/runtime.ts`, `packages/bridge/src/ports/enricher.ts` | The two ports: `Runtime`, what the bridge asks of a floor, and `Enricher` (with `Printers` and `SlashCommands`), what it adds to one. Kauak terms only. |
| `packages/bridge/src/core/` | The floors (`bridge.ts`) and what the bridge does with each message from a page: one handler per message type in `handlers.ts` (a page message type without a handler does not compile), the input queue (`input.ts`) and build mode (`build.ts`). In Kauak terms only: it knows a floor and its enrichers only through the ports. |
| `packages/bridge/src/transport/ws.ts` | The WebSocket and the built page, on one port, and the check of a page's origin. What it sends a page is a `BridgeMessage`, so every message the bridge sends is checked against the protocol when it compiles. |
| `packages/bridge/src/enrichers/context/context.ts`, `packages/bridge/src/enrichers/diffs/diffs.ts` | Context meters and printers. They read the Kauak snapshot, and ask the floor's `Runtime` for a pane's agent session and processes. |
| `packages/bridge/src/server.ts` | `createBridge`: the core with Herdr as every floor's runtime and the enrichers above. The only module that names them. |

Herdr-specific knowledge is in `runtimes/herdr/` only, apart from a few
comments that explain why the bridge does what it does.

## Bridge → page

Every message about a floor names it in `machine`. Pane, workspace and root ids
are only unique on their floor, so the page prefixes them with the machine
(`gpu-box/w1:p1`, `packages/web/src/floors/floors.ts`).

| `type` | Fields | When |
|---|---|---|
| `machines` | `machines`: MachineInfo[] | On connecting, and whenever a floor is added, removed, or changes state. |
| `machine_added` | `machine` | Answers `add_machine`. |
| `machine_error` | `message` | `add_machine` was refused. |
| `snapshot` | `machine`, `snapshot` | On connecting, and every time a floor changes. It replaces the floor's last one. |
| `prints` | `machine`, `sheets`: DiffSheet[] | On connecting: every sheet the floor's printers hold. |
| `print` | `machine`, `sheet`: DiffSheet | A printer printed a sheet: one file edit in a room's checkout. |
| `uncommitted` | `machine`, `root`, `id?`, `files`, `incomplete`, `error?` | Answers `uncommitted`. |
| `pane_output` | `machine`, `pane_id`, `text`, `seq?` | Answers `read`: rows of ANSI text joined by `\r\n`. |
| `input_ack` | `machine`, `pane_id`, `id?` | The input up to message `id` reached the pane. |
| `commands` | `machine`, `pane_id`, `agent`, `commands`: SlashCommand[] | Answers `commands`. |
| `created` | `machine`, `id?`, `pane_id` | Answers `create_desk` / `create_room`: the new pane exists and is in the floor's latest snapshot. |
| `create_error` | `machine`, `id?`, `pane_id?`, `message` | The request failed; with `pane_id`, the desk exists but its agent did not start. |
| `error` | `machine?`, `pane_id?`, `id?`, `message` | A `focus`, `read` or `input` failed. |

There are no event messages: whatever changes on a floor (a pane opens, an
agent starts working) arrives as a new `snapshot`, a few KB.

### MachineInfo

```json
{ "id": "gpu-box", "label": "gpu-box", "ssh": "dev@gpu-box", "state": "live", "message": "",
  "runtime": { "name": "Herdr", "version": "0.9.3" } }
```

`state` is `connecting`, `live` or `down`, and `message` says why in a few
words (`Herdr is not running (ENOENT)`, `ssh: Permission denied (publickey)`).
`runtime` is what runs the machine's terminals; its `version` is null until
the floor has connected.

### Snapshot

```json
{
  "workspaces": [
    { "workspace_id": "w2", "number": 2, "label": "feat/refunds", "focused": false,
      "repo": { "key": "/home/dev/code/billing-api/.git", "name": "billing-api", "root": "/home/dev/code/billing-api",
                "checkout": "/home/dev/.herdr/worktrees/billing-api/feat-refunds", "linked": true },
      "git_root": "/home/dev/.herdr/worktrees/billing-api/feat-refunds" }
  ],
  "panes": [
    { "pane_id": "w2:p1", "workspace_id": "w2", "focused": false, "cwd": "/home/dev/.herdr/worktrees/billing-api/feat-refunds",
      "title": "Add refunds to the ledger", "agent": "codex", "agent_status": "working",
      "screen": { "rows": 40, "cols": 120, "exact": true }, "scrollback": false,
      "context": { "used": 84213, "max": 258400 } }
  ]
}
```

A workspace is a room; rooms with the same `repo.key` share a wing.

| Workspace field | |
|---|---|
| `number` | Its place in the runtime's list, 1 first. |
| `focused` | The workspace the runtime is showing. |
| `repo` | The git repository the runtime opened it in, or null when it does not know. `checkout` is the room's own checkout: `root`, or a linked worktree's folder (`linked`). |
| `git_root` | The checkout the bridge found the room's folder in (`git rev-parse`), whether or not the runtime knows; the key of the room's printer. Null outside git. |

A pane is a desk, with or without an agent.

| Pane field | |
|---|---|
| `focused` | The pane the runtime has focused; at most one per floor. |
| `cwd` | The folder its program works in: the foreground process's, else the shell's. Null when unknown. |
| `title` | The terminal's title, without the status glyph agents put in front. |
| `agent` | The agent running there, by its command's name (`claude`, `codex`, `gemini`…), or null for a plain shell. |
| `agent_status` | `idle`, `working`, `blocked`, `done`, or `unknown` (no agent, or a status the runtime does not report). |
| `screen` | Its size in cells. `rows` is its real height. `cols` is its real width when `exact`; otherwise only a width the terminal panel should not go below. Null when unknown. |
| `scrollback` | There is history above the screen. |
| `context` | How full the agent's context window is (`used` and `max` tokens), when the bridge could read the agent's transcript; else null. |

## Page → bridge

| `type` | Fields | |
|---|---|---|
| `focus` | `machine`, `pane_id` | Focus the pane in the runtime. |
| `read` | `machine`, `pane_id`, `lines?`, `seq?` | The pane's screen; with `lines`, the last `lines` rows of its history and screen (at most 5000). `seq` comes back on `pane_output`, so late replies can be dropped. |
| `input` | `machine`, `pane_id`, `ops`, `id?` | Type into the pane. `ops` is an ordered list of `{ "text": "ls" }` (literal text, at most 64 KB) and `{ "keys": ["enter"] }` (named keys). Input is queued per pane and acknowledged with `input_ack`. |
| `commands` | `machine`, `pane_id` | The pane's agent's slash commands. The agent and its folder come from the snapshot, not the page. |
| `uncommitted` | `machine`, `root`, `id?` | Everything not committed in a printer's checkout. Only checkouts a room is in are read. |
| `create_desk` | `machine`, `workspace_id`, `agent`, `id?` | A new desk in a room, with an agent to start in it or null. |
| `create_room` | `machine`, `room`, `agent`, `id?` | A new room: `{ "kind": "worktree", "cwd", "branch", "base?", "label?" }` (a git worktree on a new branch) or `{ "kind": "folder", "cwd", "label?" }`. |
| `add_machine` | `ssh`, `label?` | A new floor, reached over SSH. |
| `remove_machine` | `machine` | Forget a floor; the machine is not touched. |
| `refresh` | `machine` | Send the floor's snapshot again soon. |

Key names are `enter`, `esc`, `tab`, `backspace`, `up`, `down`, `left`,
`right`, or a letter or digit, after any of `ctrl+`, `alt+` and `shift+`
(`ctrl+c`, `shift+tab`). Keys outside that list are dropped.

Every failure comes back as a plain sentence in `message` (`pane w1:p9 not
found`, `There is no folder at /tmp/x.`, git's own last line when a worktree
cannot be created); never a runtime's method name or error code.

## The Herdr adapter

What `packages/bridge/src/runtimes/herdr/herdr.ts` makes of Herdr's
`session.snapshot` (protocol 22):

| Kauak | From Herdr |
|---|---|
| `MachineInfo.runtime` | `"Herdr"` and the snapshot's `version` |
| `workspace.repo` | `worktree`: `repo_key`, `repo_name`, `repo_root`, `checkout_path`, `is_linked_worktree` |
| `pane.cwd` | `foreground_cwd`, else `cwd` |
| `pane.title` | `terminal_title_stripped`, else `terminal_title` |
| `pane.agent_status` | `agent_status`, `unknown` when it is not one of Kauak's |
| `pane.screen` | `scroll.viewport_rows` and the pane's rect in `layouts`; `exact` when the rect's height is the viewport's (on 0.9.1 the rect stayed at 120×40 whatever the client's size) |
| `pane.scrollback` | `scroll.max_offset_from_bottom > 0` |
| left out | `tabs`, `layouts`, `agents`, `terminal_id`, `tab_id`, `active_tab_id`, `revision`, counts, `protocol`, the focused ids, `agent_session` (the bridge uses it for context meters) |

And the operations a Machine offers (the `Runtime` port), with the Herdr
requests behind them:

| Machine | Herdr |
|---|---|
| `focusPane(pane)` | `pane.focus` |
| `readPane(pane, lines)` | `pane.read`, ANSI, source `recent` with `lines` and `visible` without |
| `sendText(pane, text)`, `sendKeys(pane, keys)` | `pane.send_text`; `pane.send_keys`, 64 keys at a time |
| `createDesk(workspace)` | `tab.create` in the room's checkout or its active tab's folder |
| `createRoom(spec)` | `worktree.create` or `workspace.create` |
| `startAgent(kind, pane)` | `agent.start`, retried while Herdr answers `agent_pane_busy` |
| `paneSession(pane)`, `paneProcesses(pane)` | the pane's `agent_session`; `pane.process_info` |

A Herdr event (`pane.updated`, `workspace.created`…) makes the Machine fetch a
new `session.snapshot` and emit it, translated, as `snapshot`.

## Another runtime

A second runtime would be another adapter in
`packages/bridge/src/runtimes/<name>/` implementing the `Runtime` port
(`packages/bridge/src/ports/runtime.ts`), the face `Machine` has: `id`,
`label`, `ssh`, `config`, `info`, `snapshot` and `state`; the `status` and
`snapshot` events; `start`, `stop`, `refresh` and `scheduleRefresh`; and the
operations above. `server.ts` would make it for a floor; neither the core
(`core/`, which `pnpm check:boundaries` keeps from importing a runtime) nor
the page would change.

Not part of the protocol yet, on purpose:

- **Versioning.** The page and the bridge ship together, so there is no
  handshake or protocol version.
- **Incremental updates.** A floor is always sent whole.
- **Capabilities.** Nothing says what a runtime can do. The build form's list
  of agent kinds is Herdr's, and a runtime without worktrees, tabs or agent
  statuses would need the protocol to say so.
- **Copy.** Some of the page's text still names Herdr ("Focus in Herdr", the
  build form's hints, "focused in Herdr"), as the product is built around
  it today. The text that shows the runtime's name or version (the floor chip,
  the elevator, why a floor is down) takes it from `runtime`.
