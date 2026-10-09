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

## The packages

The repository is a pnpm workspace of five packages, each with its own
`package.json` and a short README:

| Package | What it is | It imports |
|---|---|---|
| `packages/protocol/` (`@kauak/protocol`) | The Kauak protocol in one TypeScript module, `src/index.ts`: every message both ways, the snapshot, and `parseClientMessage`, which checks every message from a page. | Nothing: no other package, no Node, no DOM. |
| `packages/bridge/` (`@kauak/bridge`) | The bridge, TypeScript that Node 22.18 or newer runs as it is. | The protocol, `ws` and Node; never the page or the CLI. |
| `packages/appearance/` (`@kauak/appearance`) | Appearance packages: the included JSON looks, their contracts and the registry that validates them. | Nothing outside itself; never the bridge, the CLI or the page. Its registry imports only its contracts and uses no DOM. |
| `packages/web/` (`@kauak/web`) | The page, TypeScript with PixiJS and xterm.js, built with Vite. | The protocol, the appearance packages, PixiJS and xterm.js; never the bridge or the CLI. |
| `packages/kauak/` (`kauak`) | The `kauak` command, and the package on npm. | The bridge, which it starts, and Node; never the page. |

```
kauak ──▶ bridge ──▶ protocol ◀── web ──▶ appearance
```

Only `kauak` is published. The other four are private, and its
`package.json` names none of them: the npm package carries the page already
built into `dist/` (with the appearance packages in it) and the bridge as a
bundle with the protocol inlined. The packages that import the protocol do so
by its name, `@kauak/protocol`, never by a path into it.

`scripts/check-boundaries.mjs` (`pnpm check:boundaries`) checks every "never"
above, that the protocol imports nothing, and the bridge's own rules below, on
every source file, so a change cannot quietly cross them. Its `RULES` name
paths, so when a file moves they move with it.

## Starting it

`packages/kauak/bin/kauak.js` is the `kauak` executable. It hands its arguments
to `packages/kauak/cli/main.js`, which finds the command in `COMMANDS`, parses
its options and runs it; a new command is one module in
`packages/kauak/cli/commands/` and one entry there.

`kauak serve` (`packages/kauak/cli/commands/serve.js`) starts the bridge with
two calls to it:

1. `resolveConfig(env, flags)` (`packages/bridge/src/config.ts`) makes the
   bridge's settings, one frozen `BridgeConfig`, from the environment (the
   variables in [configuration.md](configuration.md)) and from what the entry
   point knows itself: the `--port` and `--appearance` options and where the
   built page is. No other module reads `process.env`.
2. `createBridge(config)` (`packages/bridge/src/server.ts`) makes the bridge
   and its floors, starting nothing, and returns `{ listen(), close(), floors }`.
   `listen()` starts the floors and opens the port, and resolves with the
   office's URL, or null when there is no built page; `close()` stops the
   floors, whose SSH tunnels and remote helpers are child processes, then
   closes the port.

The entry point owns the process: it calls `close()` on Ctrl+C, SIGTERM and
exit, and picks the exit code. `kauak serve` serves the built page
(`packages/kauak/dist/`) on the same port as the WebSocket, so the office is
one process and one URL. `packages/bridge/src/main.ts` is the other entry
point: it starts the bridge the same way, on its own, for `pnpm bridge` and
`pnpm dev`, which serves the page from Vite instead.

From a checkout the bridge runs from its TypeScript source, protocol included,
on Node's type stripping. The npm package cannot carry that source, since the
protocol is TypeScript and not on npm. So packing builds the page into
`packages/kauak/dist/` and bundles the bridge into `packages/kauak/bridge/`
(`packages/bridge/scripts/bundle.js`): `server.js` and `config.js`, plain
JavaScript for any Node 22 with the protocol inlined, and the two Python
helpers beside them. `serve.js` loads that bundle when it is there, and the
source when it is not, so an installed `kauak serve` needs no build.
[releasing.md](releasing.md) lists what the package contains.

## The bridge

```
server.ts    createBridge: the core, with Herdr for every floor and the enrichers
core/        ──▶ ports/, transport/ws.ts       never a runtime or an enricher
runtimes/    ──▶ ports/, ssh/                  never the core or an enricher
enrichers/   ──▶ ports/, ssh/                  never the core or a runtime
```

### The core

`packages/bridge/src/core/` is the bridge in Kauak terms. `bridge.ts` holds
the floors: this machine, always the first, plus the ones saved in
`~/.config/kauak/machines.json`, each checked before it is used. They are made
with the bridge and started by `listen()`, and "+ Add floor" adds one while it
runs. The core broadcasts each floor's state, and each of its snapshots
decorated by the floor's enrichers, to every page; every message about a floor
names its machine.

Each message from a page goes through `parseClientMessage` (`@kauak/protocol`),
which checks and trims it or drops it. Then its handler acts on it: `HANDLERS`
in `core/handlers.ts` has one for each message type, given that type's
message, and a type without one does not compile. A message about a floor that
does not exist is dropped. Input is queued per pane and run in order
(`core/input.ts`), and acknowledged with `input_ack`, after which the page
reads the pane again. Build mode's requests (`core/build.ts`) become
`createDesk` and `createRoom` on the floor's runtime, and its agent starts once
the new shell is up. Replies go back through the page's `Connection`, whose
`send` takes a `BridgeMessage`, so every message the bridge sends is checked
against the protocol when it compiles.

### The ports

The core knows a floor only through two ports, in `packages/bridge/src/ports/`:

- `Runtime` (`runtime.ts`) is what the core and the enrichers ask of one floor:
  its `id`, `label`, `ssh`, `config`, `info`, `state` and `snapshot`; the
  `status` and `snapshot` events; `start`, `stop`, `refresh` and
  `scheduleRefresh`; and the operations (`focusPane`, `readPane`, `sendText`,
  `sendKeys`, `createDesk`, `createRoom`, `startAgent`, `paneSession`,
  `paneProcesses`).
- `Enricher` (`enricher.ts`) is what the bridge adds to a floor that its
  runtime does not report: each enricher decorates the floor's snapshots, in
  turn, and says when what it adds changes. Beside it are two narrower faces
  for what also answers a page: `Printers` (the sheets, the ones a page gets
  when it connects, the uncommitted view) and `SlashCommands`.

`packages/bridge/src/server.ts` is the one module that names what implements
them. `createBridge` hands the core (`BridgeDeps` in `core/bridge.ts`) Herdr's
`Machine` for every floor, the context and diff enrichers, and the slash
commands; a test can pass its own instead. Making any of them starts nothing.

Besides the layers drawn above, `pnpm check:boundaries` keeps the transport
from importing a runtime or an enricher, and the ports and `ssh/` from
importing the core, a runtime or an enricher. Only `runtimes/herdr/` imports
`herdr.ts` or names Herdr's methods and events, and only the entry points
(`main.ts`, the CLI's `serve.js`) read `process.env`.

### The Herdr adapter

`packages/bridge/src/runtimes/herdr/machine.ts` is one Herdr server, shown as
one floor. It talks to Herdr's unix socket (newline-delimited JSON, one request
per connection), directly or through an SSH tunnel, keeps one long-lived
`events.subscribe` connection, and on every event fetches `session.snapshot`
again. `packages/bridge/src/runtimes/herdr/herdr.ts` turns that into a Kauak
snapshot (`{ workspaces, panes }`), and Herdr's errors into plain sentences.
What the bridge asks of a floor, a `Machine` offers in Kauak terms and makes
out of Herdr requests: it implements `Runtime`. Herdr-specific knowledge lives
in `runtimes/herdr/` only. [protocol.md](protocol.md#the-herdr-adapter) maps
each Kauak field and operation to Herdr's, and a second runtime would be
another adapter implementing the same port (see
[Another runtime](protocol.md#another-runtime)).

### The enrichers

What Herdr does not report, the bridge adds itself, in
`packages/bridge/src/enrichers/`:

- `context/context.ts` adds `context: { used, max }` to the Claude Code and
  Codex panes in each snapshot, from the last token count in the agent's
  transcript, and sends the snapshot again when that count changes.
- `diffs/diffs.ts` adds `git_root` to every room in a git checkout, prints a
  sheet for each file edit there (path, change, counts and unified hunks),
  keeps the last 50 for pages that connect later, and answers a printer's
  request for everything uncommitted; only checkouts a room is in are read.
  It is both an `Enricher` and the floor's `Printers`.
- `commands/commands.ts` lists a pane's slash commands. The agent and its
  folder come from the snapshot, not from the page.

### SSH floors

A remote floor runs nothing of Kauak's. Its `Machine` asks the remote shell
where Herdr's socket is, then keeps one tunnel open
(`ssh -N -L <local.sock>:<remote herdr.sock> <target>`), its local end in a
folder of the bridge's own (`tunnelDir` in the config), and talks to it exactly
like the local socket. The enrichers do their reading there through a Python
helper each, `enrichers/context/context_remote.py` (the transcripts' token
counts) and `enrichers/diffs/diffs_remote.py` (git and the files), beside the
enricher that uses it. `packages/bridge/src/ssh/remote.ts` runs a helper with
the machine's `python3` over its own SSH connection, so nothing is installed
there, and talks to it in JSON lines. ssh runs with `BatchMode=yes`, so it never
prompts; `KAUAK_SSH` sets which executable.

### The transport

`packages/bridge/src/transport/ws.ts` (`WsServer`) is how pages reach the
core: one HTTP server that serves the built page, and the WebSocket on the same
port, which accepts only pages from the allowed origins (this computer's, plus
`KAUAK_ORIGINS`). Of the protocol it knows only that what goes to a page is a
`BridgeMessage`; what a page says is the core's to read, and the core sees a
page only as a `Connection`. Making it opens nothing: the core's `listen()` and
`close()` open and close its port.

Beside the page it serves `/appearances.json` (`transport/appearances.ts`):
the `.json` files of the appearance folder (`~/.config/kauak/appearances`, or
`KAUAK_APPEARANCES`) and the files `kauak serve --appearance` names, read on
each request and passed on as they are, with their paths, or with why one could
not be read, and only to a page from the allowed origins. The bridge does not
validate them, the page does
(`packages/web/src/appearance/installed.ts`, then the appearance registry),
so a package installed on the machine is held to the same contract as one
imported in the browser. Under `pnpm dev`, Vite proxies the request to the
bridge.

## The page

The page imports the protocol's types from `@kauak/protocol`, so it knows
floors only through them. Its code is in feature folders under
`packages/web/src/`, each stylesheet beside the module that owns its markup:

| Folder | What is in it |
|---|---|
| `app/` | `main.ts`, which builds the page and connects its parts; `state.ts`, the page's state; `storage.ts`, its saved preferences; `context.ts`, the context meter's numbers; `html.ts`, the page's one HTML escape; the page-wide styles. |
| `bridge/` | `ws.ts`, the connection to the bridge, and `demo.ts`, a simulated bridge. |
| `office/` | The office: `layout.ts`, `iso.ts`, `scene.ts` and its parts, `props.ts`, `character.ts`, `roam.ts`, and build mode's form (`build.ts`). |
| `floors/` | Floor keys and why a floor is down (`floors.ts`), and the elevator (`elevator.ts`). |
| `terminal/` | The terminal panel (`panel.ts`), its "/" menu (`slash.ts`) and Claude Code's suggestion (`shadow.ts`). |
| `printers/` | The printers' sheets (`prints.ts`) and the printout you read them on (`printout.ts`). |
| `hud/` | The top bar, roster, stats and activity feed (`hud.ts`). |
| `radio/` | The radio (`radio.ts`) and its stations (`stations.ts`). |
| `appearance/` | The appearance settings (`settings.ts`), the backgrounds (`background.ts`), the banner's image (`banner-image.ts`), the bundled packages (`catalog.ts`) and the packages installed on the serving machine (`installed.ts`, from `/appearances.json`). |

The stylesheets are bundled in the order `app/main.ts` first reaches them
through its imports, so keep `./main.css` its first import and the others in
their order.

### The bridge client and the demo

`packages/web/src/bridge/ws.ts` has `BridgeApi`, what the page can ask of a
bridge, `BridgeHandlers`, what a bridge tells it, and `Bridge`, which does both
over the WebSocket. `packages/web/src/bridge/demo.ts` has `DemoBridge`, the
same interface with made-up floors and agents producing Kauak snapshots, so the
office runs with no Herdr and no bridge: `?demo`, `kauak serve --demo`, and the
static demo `pnpm build:demo` makes. `main.ts` loads it only then.

### State and storage

`packages/web/src/app/state.ts` (`AppState`) holds the page's state: the
floors (the bridge's machines and their latest snapshots), the floor on screen
(from `?floor=`, else the one saved), the selected pane, and a `?pane=` deep
link until its floor's first snapshot. It changes only through its methods (the
bridge's pushes, and the clicks and keys that change floor or select a pane),
and each tells its subscribers once what changed. The elevator, the HUD and the
terminal panel subscribe and read it; `packages/web/src/app/main.ts` builds the
page, connects the bridge to the store, and passes the store's changes on to
the office scene.

`packages/web/src/app/storage.ts` saves the page's preferences in
`localStorage`: the floor on screen, the hidden feed, the build form's agent,
the radio and the terminal panel's width, each under a `kauak.*` key. The
appearance settings are saved apart, by `@kauak/appearance` (below), and so is
the background, under `kauak.background.v1`.

### The office

Pane and workspace ids are only unique within one machine, so the client
prefixes them with their machine (`devbox/w1:p1`,
`packages/web/src/floors/floors.ts`) and the rest of the UI works with those
keys. `packages/web/src/office/layout.ts` turns a snapshot into a floor plan in
tile units, and `iso.ts` projects tiles onto the screen.

`packages/web/src/office/scene.ts` (`OfficeScene`) renders the plan with
PixiJS in layers (ground, platforms, floor and walls, depth-sorted objects,
selection overlay, labels, dust). It is the page's one entry to the office: it
builds the layers and, on every snapshot and every frame, runs its parts in a
fixed order. `floor-renderer.ts` draws a floor into the layers,
`printer-animator.ts` the rooms' printers and the sheets they print,
`picker.ts` turns the pointer into hovers and clicks and marks the selected
desk, `camera.ts` pans, zooms and fits the view and slides a new floor in, and
`tooltip.ts` owns the tooltip. The parts know each other only through their
constructor arguments; the theme and the reduced-motion setting are two small
objects the scene owns and they read.

Furniture lives in `packages/web/src/office/props.ts` and desks and people in
`packages/web/src/office/character.ts`; every visual is drawn procedurally
today, so sprites can replace the helpers one at a time.
`packages/web/src/office/roam.ts` decides where idle agents go and walks them
there round the furniture (A* on a quarter-tile grid per room), in room-local
positions, so a walk carries on when a snapshot rebuilds the office.
`packages/web/src/hud/hud.ts` owns the HTML roster, stats and activity feed,
and only updates when the store changes or the bridge connects or drops.
`packages/web/src/printers/prints.ts` holds every printer's sheets and queues
new ones for the scene to print one at a time;
`packages/web/src/printers/printout.ts` is the page you read them on, which
flies up from the tray with one CSS transform list (the office's 2:1 view of a
flat sheet is `rotateX(60deg) rotateZ(45deg)`).

## Appearance packages

Appearance packages change how the office and its people look, never what the
bridge does. They are data, not code: JSON that offers an `office.theme`, an
`office.characters` or both, validated before use. The included ones are in
`packages/appearance/packages/`. `packages/appearance/src/contracts.ts` is
their contract, and `packages/appearance/src/registry.ts` validates them
(`AppearanceRegistry`), falls back to the included default for a selection it
cannot use, and loads and saves the settings (`loadPreferences`,
`savePreferences`).

The page lists the included packages in
`packages/web/src/appearance/catalog.ts`, and `settings.ts` there is the
dialog that chooses them, imports others, offers the example
(`packages/appearance/examples/harbor.json`) and sets the company banner. The
packages installed on the serving machine come from the bridge
(`installed.ts`, above) and are registered after the included ones and before
the imported ones. The selection, the imports and the banner are saved in the
browser under `kauak.appearance.v1`. See the
[appearance and banner guide](appearance/README.md).

## Where a change goes

- **A new message** between the page and the bridge: a variant and a parser in
  `packages/protocol/src/index.ts` (a message from a page does not compile
  until `parseClientMessage` has a parser for it), then a handler in `HANDLERS`
  in `packages/bridge/src/core/handlers.ts` (nor until it has one there), then
  the page's `packages/web/src/bridge/`: `ws.ts`, and `demo.ts` so the demo
  keeps working. Then [protocol.md](protocol.md).
- **A new runtime**: an adapter in `packages/bridge/src/runtimes/<name>/` that
  implements `Runtime`, which `server.ts` makes for the floors it runs. Neither
  the core nor the page changes, and `pnpm check:boundaries` fails if the core
  imports it, or it imports the core or an enricher. See
  [Another runtime](protocol.md#another-runtime).
- **A new office look**: a JSON file in `packages/appearance/packages/`, added
  to `bundledPackages` in `packages/web/src/appearance/catalog.ts`. The scene
  has no switch per package. A look for your own office needs no change at all:
  import its JSON in the settings, or put it in `~/.config/kauak/appearances/`.

## Tests and checks

Tests sit next to the code they test. The page's are TypeScript, `*.test.ts`,
run by Vitest in Node, with no browser or DOM. The others (protocol,
appearance, bridge, CLI and `scripts/`) are `*.test.mjs`, run by Node's own
runner, `node:test`. `pnpm test` runs every package's tests, then those in
`scripts/`.

The bridge's tests start the real bridge in their own process with
`createBridge`, against a stand-in Herdr
(`packages/bridge/src/runtimes/herdr/fixtures/fake-herdr.mjs`, answering from a
scrubbed real snapshot), and check that nothing of Herdr's reaches the
WebSocket. They also run the core with a stand-in runtime and stand-in
enrichers, as a second runtime would be.

`pnpm check` runs Biome (`pnpm lint`), the boundary check
(`pnpm check:boundaries`) and the type check of every TypeScript package
(`pnpm typecheck`). `pnpm verify:pack` packs the npm package, installs it three
ways and runs `kauak serve` from each ([releasing.md](releasing.md)). CI
(`.github/workflows/ci.yml`) runs all of them on Node 22 and 24, and
`pnpm verify:pack` on Node 22.0.0 too, the oldest Node the package supports.
[CONTRIBUTING.md](../CONTRIBUTING.md) has the order to run them in.
