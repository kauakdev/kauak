# How Kauak works

Kauak has two halves. The bridge (`packages/bridge/`, Node) runs on your
machine, talks to every Herdr server it knows about and sends what it learns to
the page over a WebSocket. The page (`packages/web/`, TypeScript and PixiJS)
turns that into the office and sends your clicks and keystrokes back. Between
them is the Kauak protocol (`packages/protocol/`, TypeScript, imported by
both), which belongs to Kauak, not to Herdr: Herdr's methods, fields, events
and errors stop at the bridge's Herdr adapter.

```
Herdr on this machine (unix socket)     Herdr on another machine (through an SSH tunnel)
   │  Herdr's API: session.snapshot, events.subscribe, pane.read…
   ▼
Herdr adapter    packages/bridge/src/runtimes/herdr/ (machine.ts + herdr.ts), one Machine per floor
   │  Kauak terms, the Runtime port: info, snapshot, readPane, createRoom…
   ▼
Bridge core      packages/bridge/src/core/, with enrichers/ through the Enricher port
   │  the Kauak protocol (packages/protocol), over a WebSocket (packages/bridge/src/transport/ws.ts)
   ▼
Page             packages/web/src/bridge/ws.ts → the office      (packages/web/src/bridge/demo.ts speaks it too, with no bridge)
```

The message formats are in [protocol.md](protocol.md). This page is about the
code around them.

## Starting it

`packages/kauak/bin/kauak.js` is the `kauak` executable. It hands its arguments
to `packages/kauak/cli/main.js`, which finds the command in `COMMANDS`, parses
its options and runs it; a new command is one module in
`packages/kauak/cli/commands/` and one entry there.

Loading the bridge starts nothing. Its settings are one frozen object that
`resolveConfig(env, flags)` (`packages/bridge/src/config.ts`) makes from the
environment (the variables in [configuration.md](configuration.md)) and from
what the entry point knows itself: the `--port` option and where the built page
is. No other module reads `process.env`. Before that, each entry point calls
`copyLegacyFloors(env)`, in the same file, which copies the floors saved before
the rename to the kauak folder once.
`createBridge(config)` (`packages/bridge/src/server.ts`) makes
the floors, starting nothing, and returns `{ listen(), close(), floors }`:
`listen()` starts the floors and opens the port, and resolves with the office's
URL, or null when there is no built page; `close()` stops the floors, whose SSH
tunnels and remote helpers are child processes, then closes the port. The entry
point owns the process: it calls `close()` on Ctrl+C, SIGTERM and exit, and
picks the exit code.

There are two entry points. `kauak serve`
(`packages/kauak/cli/commands/serve.js`) serves the built page
(`packages/kauak/dist/`) on the same port as the WebSocket, so the office is one
process and one URL. The npm package ships the page as `dist/`, already built,
with the bridge bundled beside the CLI (`prepack` does both), so an installed
`kauak serve` needs no build. From a checkout the bridge runs from its
TypeScript source, protocol included, on Node's type stripping.
`packages/bridge/src/main.ts` runs the bridge on its own, for `pnpm bridge`
and `pnpm dev`, which serves the page from Vite instead.

## The Herdr adapter

`packages/bridge/src/runtimes/herdr/machine.ts` is one Herdr server, shown as
one floor. It talks to Herdr's unix socket (newline-delimited JSON, one request
per connection), directly or through an SSH tunnel, keeps one long-lived
`events.subscribe` connection, and on every event fetches `session.snapshot`
again. `packages/bridge/src/runtimes/herdr/herdr.ts` turns that into a Kauak
snapshot (`{ workspaces, panes }`), and Herdr's errors into plain sentences.
What the bridge asks of a floor, a Machine offers in Kauak terms (`readPane`,
`sendText`, `sendKeys`, `createDesk`, `createRoom`, `startAgent`, `focusPane`,
the agent session and processes of a pane) and makes out of Herdr requests:
that face is the `Runtime` port (`packages/bridge/src/ports/runtime.ts`), which
`Machine` implements. Herdr-specific knowledge lives in `runtimes/herdr/` only;
a second runtime would be another adapter implementing the same port (see
[Another runtime](protocol.md#another-runtime)).

For a remote floor, the Machine asks the remote shell where Herdr's socket is,
then keeps one tunnel open (`ssh -N -L <local.sock>:<remote herdr.sock>
<target>`) and talks to it exactly like the local socket.

## The bridge server

`packages/bridge/src/core/bridge.ts`, the bridge's core, holds the floors
(this machine, plus the ones saved in `~/.config/kauak/machines.json`) and
speaks only the Kauak protocol. It broadcasts each floor's state and snapshot
to every page, and every message about a floor names its machine. Each message
from a page goes through `parseClientMessage` (`@kauak/protocol`,
`packages/protocol/src/index.ts`), which checks and trims it or drops it; the
protocol's types are in the same file. Then its handler acts on it:
`HANDLERS` in `packages/bridge/src/core/handlers.ts` has one for each message
type, given that type's message, and a type without one does not compile. A
message about a floor that does not exist is dropped. Input is queued per pane
and run in order (`core/input.ts`), and acknowledged with `input_ack`, after
which the page reads the pane again. Build mode's requests (`core/build.ts`)
become `createDesk` and `createRoom` on the floor's runtime, and its agent
starts once the new shell is up.

Pages reach the core through `packages/bridge/src/transport/ws.ts`: one HTTP
server that serves the built page, and the WebSocket on the same port, which
accepts only pages from the allowed origins. The core sees a page only as a
`Connection`, whose `send` takes a `BridgeMessage`, so every message the
bridge sends is checked against the protocol when it compiles.

The core knows a floor only through two ports, in `packages/bridge/src/ports/`.
`Runtime` (`runtime.ts`) is what it asks of a floor, above. `Enricher`
(`enricher.ts`) is what the bridge adds to a floor: each enricher decorates the
floor's snapshots, in turn, and says when that changes. Beside it are two
narrower faces for what also answers a page: `Printers` (the sheets, the ones a
page gets when it connects, the uncommitted view) and `SlashCommands`.
`packages/bridge/src/server.ts` is the one module that names what implements
them: Herdr's `Machine` for every floor, the two enrichers, and the slash
commands. The core and the transport import none of them, which
`pnpm check:boundaries` checks.

What Herdr does not report, the bridge adds itself, in
`packages/bridge/src/enrichers/`:

- `context/context.ts` adds `context: { used, max }` to the Claude Code and
  Codex panes in each snapshot, from the last token count in the agent's
  transcript, and sends the snapshot again when that count changes. For a
  remote floor it keeps one more SSH connection open, running
  `context/context_remote.py` there, and asks it for the counts in JSON lines.
- `diffs/diffs.ts` adds `git_root` to every room in a git checkout, prints a
  sheet for each file edit there (path, change, counts and unified hunks),
  keeps the last 50 for pages that connect later, and answers a printer's
  request for everything uncommitted; only checkouts a room is in are read. On
  a remote floor it does its git and file reads through `diffs/diffs_remote.py`
  over its own SSH connection.
- `commands/commands.ts` lists a pane's slash commands. The agent and its
  folder come from the snapshot, not from the page.

`packages/bridge/src/ssh/remote.ts` runs both remote scripts, with the
machine's `python3`, so nothing is installed there; each script sits beside the
enricher that uses it.

The tests start the real server in their own process with `createBridge`,
against a stand-in Herdr
(`packages/bridge/src/runtimes/herdr/fixtures/fake-herdr.mjs`, answering from a
scrubbed real snapshot), and check that nothing of Herdr's reaches the
WebSocket. They also run the core with a stand-in runtime and stand-in
enrichers, as a second runtime would be.

## The page

The page imports the protocol's types from `@kauak/protocol`, so it knows floors
only through them. `packages/web/src/bridge/ws.ts` is the connection to the
bridge and `packages/web/src/bridge/demo.ts` a simulated bridge with the same
interface, producing Kauak snapshots of made-up agents.

`packages/web/src/app/state.ts` holds the page's state: the floors (the bridge's
machines and their latest snapshots), the floor on screen (from `?floor=`, else
the one saved in `localStorage`), the selected pane, and a `?pane=` deep link
until its floor's first snapshot. It changes only through its methods (the
bridge's pushes, and the clicks and keys that change floor or select a pane),
and each tells its subscribers once what changed. The elevator, the HUD and the
terminal panel subscribe and read it; `packages/web/src/app/main.ts` builds the
page, connects the bridge to the store, and passes the store's changes on to the
office scene.

Pane and workspace ids are only unique within one machine, so the client
prefixes them with their machine (`devbox/w1:p1`,
`packages/web/src/floors/floors.ts`) and the rest of the UI works with those
keys. `packages/web/src/floors/elevator.ts` is the floor switcher.
`packages/web/src/office/layout.ts` turns a snapshot into a floor plan in tile
units. `packages/web/src/office/scene.ts` renders it with PixiJS in layers
(ground, platforms, floor and walls, depth-sorted objects, selection overlay,
labels, dust). Furniture lives in `packages/web/src/office/props.ts` and
desks/people in `packages/web/src/office/character.ts`; every visual is drawn
procedurally today so sprites can replace the helpers one at a time.
`packages/web/src/office/roam.ts` decides where idle agents go and walks them
there round the furniture (A* on a quarter-tile grid per room), in room-local
positions so a walk carries on when a snapshot rebuilds the office.
`packages/web/src/hud/hud.ts` owns the HTML roster, stats and activity feed, and
only updates when the store changes or the bridge connects or drops.
`packages/web/src/printers/prints.ts` holds every printer's sheets and queues
new ones for the scene to print one at a time;
`packages/web/src/printers/printout.ts` is the page you read them on, which
flies up from the tray with one CSS transform list (the office's 2:1 view of a
flat sheet is `rotateX(60deg) rotateZ(45deg)`).

Appearance packages (`packages/appearance/packages/`, validated by
`packages/appearance/src/`) change how the office and its people look, never
what the bridge does. See the
[appearance and banner guide](appearance/README.md).
