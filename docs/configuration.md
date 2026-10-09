# Configuration

Kauak needs a running Herdr server (0.9.x, protocol 22) and Node 22+.

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
- `KAUAK_CONFIG`: saved floors (default `~/.config/kauak/machines.json`)
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
