# Configuration

Kauak needs Node 22+, and a running Herdr server (0.9.x, protocol 22) or T3
Code server (0.0.45, orchestration protocol 1) to show; the demo needs neither.

## Command-line options

`kauak serve` starts the bridge and opens the office at http://127.0.0.1:7788,
and runs until Ctrl+C. Options: `-p, --port <n>`, `--no-open`, `--demo`
(simulated agents, no Herdr needed) and `--appearance <file>` (an appearance
package to offer in the page's settings, besides those in the appearance
folder below; repeat it for several). `kauak` on its own runs `kauak serve`,
and takes the same options: `kauak --demo`, `kauak -p 8080`.

`kauak help` (or `kauak --help`) lists the commands, `kauak help serve` (or
`kauak serve --help`) shows a command's options, and `kauak --version` prints
the version. The exit code is 0 when it worked, 1 when the command failed and 2
when the command line is wrong.

## Environment variables

- `HERDR_SOCKET_PATH`: path to this machine's Herdr socket (default `~/.config/herdr/herdr.sock`; `HERDR_SOCKET` also works)
- `KAUAK_PORT`: port of the bridge and the page it serves (default `7788`; `--port` sets it too)
- `KAUAK_HOST`: interface the bridge listens on (default `127.0.0.1`, this computer only)
- `KAUAK_ORIGINS`: extra page hostnames allowed to connect, comma separated (default: only `localhost`/`127.0.0.1`)
- `KAUAK_CONFIG`: saved floors (default `~/.config/kauak/machines.json`); T3 Code floors' tokens go in `tokens/` beside it
- `KAUAK_APPEARANCES`: folder of appearance packages the bridge serves to the page (default `~/.config/kauak/appearances`; see the [appearance guide](appearance/README.md))
- `KAUAK_SSH`: SSH executable (default `ssh`)
- `VITE_BRIDGE_PORT`: port the page connects to (default: `7788` under `pnpm dev`, else the port the page was served from)

Floors are saved in `~/.config/kauak/machines.json`.

## Opening the office from another device

The bridge can type into your terminals and open SSH connections, so it only
listens on 127.0.0.1 and refuses WebSocket connections from other web pages.
To open the office from another device, set `KAUAK_HOST=0.0.0.0` and
`KAUAK_ORIGINS=<the hostname you browse to>` (under `pnpm dev`, also run
Vite with `--host`), and keep it on a network you trust. See
[SECURITY.md](../SECURITY.md) for what that exposes.

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
`~/.config/kauak/machines.json`, which you can also edit by hand:

```json
{ "machines": [
  { "id": "devbox", "label": "devbox", "ssh": "devbox" },
  { "id": "gpu", "label": "gpu box", "ssh": "me@gpu", "remoteSocket": "/home/me/.config/herdr/herdr.sock" },
  { "id": "side", "label": "side session", "socket": "/home/me/.config/herdr/sessions/side/herdr.sock" }
] }
```

`remoteSocket` skips the lookup on the remote machine; `socket` adds a local
Herdr socket (another Herdr session on this machine) as its own floor.

## T3 Code floors

A [T3 Code](https://github.com/pingdotgg/t3code) server on this machine can be
a floor too: its projects' folders and worktrees are rooms, and each thread
still in play (not settled or archived) is a desk with its agent. The bridge
reaches it at its address, `http://127.0.0.1:3773` for the desktop app (the
port is in `~/.t3/userdata/server-runtime.json`), with a bearer token the
server issued. Make one with T3 Code's CLI, the same version as the app:

```sh
npx t3@0.0.45 auth session issue --token-only --label kauak --ttl 30d
```

Then "+ Add floor", **T3 Code**, and paste it. The bridge keeps the token in
`~/.config/kauak/tokens/<floor>.token`, readable only by you, and never in
`machines.json`; removing the floor deletes it. T3 Code lists the session under
its connected clients, where you can revoke it. A floor added by hand needs
its token file:

```json
{ "machines": [
  { "id": "t3-code", "label": "T3 Code", "runtime": "t3", "url": "http://127.0.0.1:3773" }
] }
```

A thread has no terminal, so its desk shows a transcript of its latest turns,
the message box sends a message (Esc stops the agent's turn), and an approval
or a question the agent asks shows up as buttons under it. Kauak speaks T3
Code's orchestration protocol 1; a server that speaks another (T3 Code's
next releases) is shown as down, saying so. A T3 Code floor must be on this
machine, as the printers and context meters read its rooms' files here.
