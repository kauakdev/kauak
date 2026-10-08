# How Kauak works

Kauak has two halves. The bridge (`bridge/`, Node) runs on your machine, talks
to every Herdr server it knows about and sends what it learns to the page over
a WebSocket. The page (`web/`, TypeScript and PixiJS) turns that into the office
and sends your clicks and keystrokes back. Between them is the Kauak protocol,
which belongs to Kauak, not to Herdr: Herdr's methods, fields, events and
errors stop at the bridge's Herdr adapter.

```
Herdr on this machine (unix socket)     Herdr on another machine (through an SSH tunnel)
   │  Herdr's API: session.snapshot, events.subscribe, pane.read…
   ▼
Herdr adapter    bridge/machine.js + bridge/herdr.js, one Machine per floor
   │  Kauak terms: info, snapshot, readPane, createRoom…
   ▼
Bridge server    bridge/server.js, with context.js, diffs.js and commands.js
   │  the Kauak protocol, over a WebSocket
   ▼
Page             web/src/ws.ts → the office      (web/src/demo.ts speaks it too, with no bridge)
```

The message formats are in [protocol.md](protocol.md). This page is about the
code around them.

## Starting it

`bin/kauak.js` is the `kauak` executable. It hands its arguments to
`cli/main.js`, which finds the command in `COMMANDS`, parses its options and
runs it; a new command is one module in `cli/commands/` and one entry there.
`kauak serve` (`cli/commands/serve.js`) loads `bridge/server.js`, which starts
listening as it is loaded and serves the built page (`dist/`) on the same port
as the WebSocket, so the office is one process and one URL. The npm package
ships `dist/` already built (`prepack` builds it), so an installed
`kauak serve` needs no build. `pnpm dev` runs the bridge on its own and serves
the page from Vite instead.

## The Herdr adapter

`bridge/machine.js` is one Herdr server, shown as one floor. It talks to
Herdr's unix socket (newline-delimited JSON, one request per connection),
directly or through an SSH tunnel, keeps one long-lived `events.subscribe`
connection, and on every event fetches `session.snapshot` again.
`bridge/herdr.js` turns that into a Kauak snapshot (`{ workspaces, panes }`),
and Herdr's errors into plain sentences. What the bridge asks of a floor, a
Machine offers in Kauak terms (`readPane`, `sendText`, `sendKeys`,
`createDesk`, `createRoom`, `startAgent`, `focusPane`, the agent session and
processes of a pane) and makes out of Herdr requests. Herdr-specific knowledge
lives in these two files only; a second runtime would be another adapter with
the same face (see [Another runtime](protocol.md#another-runtime)).

For a remote floor, the Machine asks the remote shell where Herdr's socket is,
then keeps one tunnel open (`ssh -N -L <local.sock>:<remote herdr.sock>
<target>`) and talks to it exactly like the local socket.

## The bridge server

`bridge/server.js` holds the floors (this machine, plus the ones saved in
`~/.config/kauak/machines.json`) and speaks only the Kauak protocol. It
broadcasts each floor's state and snapshot to every page, and every message
about a floor names its machine. Each message from a page goes through
`parseClientMessage` (`bridge/protocol.js`), which checks and trims it or drops
it; the protocol's types are in `bridge/protocol.d.ts`. Input is queued per
pane and run in order, and acknowledged with `input_ack`, after which the page
reads the pane again. Build mode's requests become `createDesk` and
`createRoom` on the floor's Machine, and its agent starts once the new shell is
up.

Three trackers add what Herdr does not report:

- `bridge/context.js` adds `context: { used, max }` to the Claude Code and
  Codex panes in each snapshot, from the last token count in the agent's
  transcript, and sends the snapshot again when that count changes. For a
  remote floor it keeps one more SSH connection open, running
  `bridge/context_remote.py` there, and asks it for the counts in JSON lines.
- `bridge/diffs.js` adds `git_root` to every room in a git checkout, prints a
  sheet for each file edit there (path, change, counts and unified hunks),
  keeps the last 50 for pages that connect later, and answers a printer's
  request for everything uncommitted; only checkouts a room is in are read. On
  a remote floor it does its git and file reads through
  `bridge/diffs_remote.py` over its own SSH connection. `bridge/remote.js` runs
  both remote scripts, with the machine's `python3`, so nothing is installed
  there.
- `bridge/commands.js` lists a pane's slash commands. The agent and its folder
  come from the snapshot, not from the page.

The tests run the real server against a stand-in Herdr
(`bridge/fixtures/fake-herdr.mjs`, answering from a scrubbed real snapshot),
and check that nothing of Herdr's reaches the WebSocket.

## The page

`web/src/types.ts` re-exports the protocol's types, so the page knows floors
only through them. `web/src/ws.ts` is the connection to the bridge and
`web/src/demo.ts` a simulated bridge with the same interface, producing Kauak
snapshots of made-up agents.

Pane and workspace ids are only unique within one machine, so the client
prefixes them with their machine (`devbox/w1:p1`, `web/src/floors.ts`) and the
rest of the UI works with those keys. `web/src/elevator.ts` is the floor
switcher. `web/src/layout.ts` turns a snapshot into a floor plan in tile units.
`web/src/scene.ts` renders it with PixiJS in layers (ground, platforms, floor
and walls, depth-sorted objects, selection overlay, labels, dust). Furniture
lives in `web/src/props.ts` and desks/people in `web/src/character.ts`; every
visual is drawn procedurally today so sprites can replace the helpers one at a
time. `web/src/roam.ts` decides where idle agents go and walks them there
round the furniture (A* on a quarter-tile grid per room), in room-local
positions so a walk carries on when a snapshot rebuilds the office.
`web/src/hud.ts` owns the HTML roster, stats and activity feed, and only
updates when the bridge pushes something new. `web/src/prints.ts` holds every
printer's sheets and queues new ones for the scene to print one at a time;
`web/src/printout.ts` is the page you read them on, which flies up from the
tray with one CSS transform list (the office's 2:1 view of a flat sheet is
`rotateX(60deg) rotateZ(45deg)`).

Appearance packages (`plugins/`, validated by `shared/plugins/`) change how the
office and its people look, never what the bridge does. See the
[plugin and banner guide](plugins/README.md).
