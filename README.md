# Agent Office

A Sims-style isometric office that shows what your [Herdr](https://herdr.dev) coding agents are doing.

| Herdr object | In the office |
|---|---|
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

Hover a desk for the terminal title and cwd. Click a desk to open a read-only
mirror of that pane's terminal in a side panel (xterm.js, refreshed only when
Herdr reports new output). "Focus in Herdr" switches your Herdr window to the
pane; `Esc` closes the panel. `?pane=w1:p1` in the URL opens a pane on load.
Drag to pan, wheel to zoom.

## Run

Requires a running Herdr server (0.9.x, protocol 22) and Node 20+.

```sh
pnpm install
pnpm dev        # bridge on ws://localhost:7788 + Vite on http://localhost:5178
```

Environment variables:

- `HERDR_SOCKET`: path to the Herdr unix socket (default `~/.config/herdr/herdr.sock`)
- `AGENT_OFFICE_PORT`: bridge WebSocket port (default `7788`)
- `VITE_BRIDGE_PORT`: port the browser connects to (default `7788`)

## How it works

`bridge/server.js` talks to the Herdr unix socket (newline-delimited JSON, one
request per connection) and keeps one long-lived `events.subscribe` connection.
On every event it re-fetches `session.snapshot` and broadcasts it to browser
clients over WebSocket. Clients send `{ "type": "focus", "pane_id": "w1:p1" }`
to focus a pane and `{ "type": "read", "pane_id": "w1:p1" }` to get the pane's
visible viewport as ANSI text (`pane.read`).

`web/src/layout.ts` turns a snapshot into a floor plan in tile units.
`web/src/scene.ts` renders it with PixiJS; every visual is drawn procedurally
today so sprites can replace the `draw*` helpers one at a time.
