# Agent Office

A Sims-style isometric office that shows what your [Herdr](https://herdr.dev) coding agents are doing.

**[Try the demo](https://agustinrbeltran.github.io/agent-office/)** (simulated agents, nothing to install),
or run it on your own agents with `npx agentoffice`.

| Herdr object | In the office |
|---|---|
| Machine running Herdr | Floor (this machine is 1F) |
| Repository (grouped by `worktree.repo_key`) | Wing (a row of rooms) |
| Workspace / worktree | Room |
| Pane | Desk (with or without someone at it) |
| Agent | Person at the desk, colored by agent kind |

Agent lifecycle states drive the animation:

- **working**: typing, code glyphs float up from the laptop
- **idle**: leaning back with a coffee bubble
- **blocked**: hand raised, `?` bubble pulses, room outline pulses red
- **done**: `✓` bubble hops until the pane is seen
- **unknown**: greyed out

Each room is a raised platform with windows, a whiteboard or poster, a rug,
plants, a bookshelf and a lounge in any spare desk cell. Wings get a floor tint
and a sign with room/desk/agent counts; room plaques show one status dot per
desk. Monitors show scrolling code while an agent works and a blinking prompt
when the desk is empty.

Around the canvas:

- **Top bar**: the floor on screen and its connection state, live counts per
  status across all floors (the tab title shows a `(N blocked)` prefix), clock,
  zoom and fit buttons.
- **Floors** (top right): the elevator. One button per machine, top floor
  first, with its connection state and how many agents there are blocked or
  done, so you notice activity on floors you are not looking at. Click one
  (or press its number) to take the elevator there. "+ Add floor" adds a
  machine by SSH target; hover a floor for its full status and a remove button.
- **Roster** (left): every pane on every floor, grouped by floor, repository and
  workspace, with the time spent in its current status. Click a row to jump to
  that desk, on whatever floor it is.
- **Activity** (bottom right): status changes, arrivals and departures seen
  during this session, tagged with their floor. Click an entry to jump to the desk.

Hover a desk for the terminal title and cwd. Click anywhere on a desk (the
person, the chair, the floor around it: the outline that lights up on hover),
or a roster row, to select it: a plumbob appears over it, the camera glides to it and the pane's
terminal opens in a side panel (xterm.js, polled a few times a second and
redrawn only when the viewport text changes). The terminal is live: anything you type there is sent to the pane, so
you can answer an agent's question or run a command without leaving the office.
Printable text goes through Herdr's `pane.send_text`; Enter, Esc, arrows,
Tab, Backspace, function keys and Ctrl/Alt combos go through `pane.send_keys`,
so the pane's own key encoding (bracketed paste, application cursor keys) is
honored. Herdr reports no cursor position and every request takes ~100 ms, so
the panel tracks the caret from your keystrokes and echoes text typed at the
end of the line right away, until the pane's own echo arrives
(`web/src/caret.ts`). The terminal keeps the pane's exact size and shrinks its
font to fit the panel. The "Live input" button toggles the panel back to read-only. "Focus
in Herdr" switches your Herdr window to the pane. `?pane=w1:p1` in the URL
opens a pane on load (`?pane=<floor>/w1:p1` for another floor; `?floor=<id>`
just picks the floor).

**Build mode** (the Build button, or `B`) adds desks and rooms. Every room
grows a ghost desk with a `+`, every wing ends in a dashed "New room" plot, and
one more plot below the wings takes a room in any other folder. Click one and
a small form asks what to create:

- **New desk**: splits the room's biggest pane in Herdr (to the right when it
  is wide, else down) in the same folder, with an optional agent.
- **New room**: a **git branch** (Herdr's `worktree.create`: a new worktree
  under `~/.herdr/worktrees`, opened as a room in the repository's wing) or a
  **folder** (`workspace.create`). On this machine `~` is expanded and a
  folder that does not exist is refused; a remote floor needs an absolute path.
- **Agent**: none (a plain shell) or any kind Herdr knows (`herdr agent`).
  The agent's command must be installed on that machine; the bridge starts it
  with `agent.start` once the new shell is up.

The new desk's terminal opens as soon as Herdr has the pane. Nothing is ever
closed or removed from here.

Keys: `J`/`K` next/previous desk, `1`–`9` go to that floor, `PgUp`/`PgDn` one
floor up/down, `F` fit the office, `R` toggle roster, `B` build mode, `+`/`-`
zoom, `Esc` close the build form, the add-floor form or the panel, then leave
build mode. While the terminal has keyboard focus
these shortcuts are off and every key, including `Esc`, goes to the pane;
click outside the terminal to get them back. Click an empty spot in the
office to close the panel. Drag to pan (a drag never selects or closes
anything), wheel to zoom.

## Run

Requires a running Herdr server (0.9.x, protocol 22) and Node 20+.

```sh
npx agentoffice
```

That starts the bridge and opens the office at http://127.0.0.1:7788. Options:
`--port <n>`, `--no-open`, and `--demo` (simulated agents, no Herdr needed).

From a checkout:

```sh
pnpm install
pnpm dev        # bridge on ws://localhost:7788 + Vite on http://localhost:5178
```

Environment variables:

- `HERDR_SOCKET_PATH`: path to this machine's Herdr socket (default `~/.config/herdr/herdr.sock`; `HERDR_SOCKET` also works)
- `AGENT_OFFICE_PORT`: port of the bridge and the page it serves (default `7788`; `--port` sets it too)
- `AGENT_OFFICE_HOST`: interface the bridge listens on (default `127.0.0.1`, this computer only)
- `AGENT_OFFICE_ORIGINS`: extra page hostnames allowed to connect, comma separated (default: only `localhost`/`127.0.0.1`)
- `AGENT_OFFICE_CONFIG`: saved floors (default `~/.config/agent-office/machines.json`)
- `VITE_BRIDGE_PORT`: port the page connects to (default: `7788` under `pnpm dev`, else the port the page was served from)

The bridge can type into your terminals and open SSH connections, so it only
listens on 127.0.0.1 and refuses WebSocket connections from other web pages.
To open the office from another device, set `AGENT_OFFICE_HOST=0.0.0.0` and
`AGENT_OFFICE_ORIGINS=<the hostname you browse to>` (under `pnpm dev`, also run
Vite with `--host`), and keep it on a network you trust.

## Remote machines (floors)

Herdr only listens on a local unix socket, so remote machines are reached over
SSH: "+ Add floor" takes an SSH target (`host`, `user@host` or an alias from
`~/.ssh/config`). The bridge asks the remote shell where Herdr's socket is,
then keeps one tunnel open per machine
(`ssh -N -L <local.sock>:<remote herdr.sock> <target>`) and talks to it exactly
like the local socket. Requirements on the remote machine: Herdr running, and
SSH login without a password prompt (keys or an agent; the bridge runs ssh with
`BatchMode=yes`, so it never prompts). If the host key is new, run
`ssh <target>` once in a terminal to accept it.

A floor that drops keeps its last snapshot, shows why in the elevator (`ssh
key refused`, `offline · ssh timed out`, `Herdr is not running`, …) and
reconnects on its own with backoff. Floors are saved in
`~/.config/agent-office/machines.json`, which you can also edit by hand:

```json
{ "machines": [
  { "id": "madryn", "label": "ubuntu-madryn", "ssh": "ubuntu-madryn" },
  { "id": "gpu", "label": "gpu box", "ssh": "me@gpu", "remoteSocket": "/home/me/.config/herdr/herdr.sock" },
  { "id": "side", "label": "side session", "socket": "/home/me/.config/herdr/sessions/side/herdr.sock" }
] }
```

`remoteSocket` skips the lookup on the remote machine; `socket` adds a local
Herdr socket (another Herdr session on this machine) as its own floor.

## Demo

`?demo` in the URL (or `npx agentoffice --demo`) swaps the bridge for a
simulated one (`web/src/demo.ts`): two floors of made-up agents that work, get
blocked and finish on their own. The terminal panel works there too: Enter or
Esc answers a blocked agent, a typed task puts an idle one to work, and shell
panes run a few commands (`help`, `git status`, `claude`…). "+ Add floor"
adds a made-up machine. `pnpm build:demo` builds it as a static site in
`dist-demo/`, and `.github/workflows/demo.yml` publishes that to GitHub Pages
on every push to `main`.

## How it works

`bridge/server.js` also serves the built page (`dist/`) on the same port,
so `npx agentoffice` (`bin/agentoffice.js`) is one process and one URL.
`bridge/machine.js` is one Herdr server: it talks to its unix socket
(newline-delimited JSON, one request per connection) directly or through the
SSH tunnel, keeps one long-lived `events.subscribe` connection, and on every
event re-fetches `session.snapshot`. `bridge/server.js` holds the floors and
broadcasts `{ "type": "machines", "machines": [...] }` (id, label, SSH target,
state, message) and `{ "type": "snapshot", "machine": "local", "snapshot": {...} }`
to browser clients over WebSocket. Every pane message names its machine.
Clients send `{ "type": "focus", "machine": "local", "pane_id": "w1:p1" }` to
focus a pane, `{ "type": "read", "machine": "local", "pane_id": "w1:p1" }` to
get the pane's visible viewport as ANSI text (`pane.read`),
`{ "type": "input", "machine": "local", "pane_id": "w1:p1", "ops": [{ "text": "ls" }, { "keys": ["enter"] }] }`
to type into it, and `add_machine` (`ssh`, `label`) / `remove_machine`
(`machine`) to manage floors. The bridge runs the ops in order (`pane.send_text` /
`pane.send_keys`), serialized per pane, and answers with `input_ack`, after
which the client re-reads the viewport. `web/src/keys.ts` translates the bytes
xterm.js emits for keystrokes into those ops.

Pane, tab and workspace ids are only unique within one Herdr server, so the
client prefixes them with their machine (`madryn/w1:p1`, `web/src/floors.ts`)
and the rest of the UI works with those keys. `web/src/elevator.ts` is the
floor switcher. `web/src/layout.ts` turns a snapshot into a floor plan in tile units.
`web/src/scene.ts` renders it with PixiJS in layers (ground, platforms, floor
and walls, depth-sorted objects, selection overlay, labels, dust). Furniture
lives in `web/src/props.ts` and desks/people in `web/src/character.ts`; every
visual is drawn procedurally today so sprites can replace the helpers one at a
time. `web/src/hud.ts` owns the HTML roster, stats and activity feed, and only
updates when the bridge pushes something new.

## License

[Apache 2.0](LICENSE).

Agent Office is an independent project. It is not affiliated with or endorsed by Herdr.
