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

Each room is a raised platform with windows, a whiteboard or poster, a rug,
plants, a bookshelf and a lounge in any spare desk cell. Wings get a floor tint
and a sign with room/desk/agent counts; room plaques show one status dot per
desk. Monitors show scrolling code while an agent works and a blinking prompt
when the desk is empty.

Around the canvas:

- **Top bar**: connection state, live counts per status (the tab title shows
  a `(N blocked)` prefix), clock, zoom and fit buttons.
- **Roster** (left): every pane grouped by repository and workspace, with the
  time spent in its current status. Click a row to jump to that desk.
- **Activity** (bottom right): status changes, arrivals and departures seen
  during this session. Click an entry to jump to the desk.

Hover a desk for the terminal title and cwd. Click a desk (or a roster row) to
select it: a plumbob appears over it, the camera glides to it and a read-only
mirror of the pane's terminal opens in a side panel (xterm.js, refreshed only
when Herdr reports new output). "Focus in Herdr" switches your Herdr window to
the pane. `?pane=w1:p1` in the URL opens a pane on load.

Keys: `J`/`K` next/previous desk, `F` fit the office, `R` toggle roster,
`+`/`-` zoom, `Esc` close the panel. Drag to pan, wheel to zoom.

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
`web/src/scene.ts` renders it with PixiJS in layers (ground, platforms, floor
and walls, depth-sorted objects, selection overlay, labels, dust). Furniture
lives in `web/src/props.ts` and desks/people in `web/src/character.ts`; every
visual is drawn procedurally today so sprites can replace the helpers one at a
time. `web/src/hud.ts` owns the HTML roster, stats and activity feed, and only
updates when a new snapshot arrives.
