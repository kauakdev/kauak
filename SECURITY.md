# Security

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub: on the repository's
**Security** tab, choose **Report a vulnerability**. That opens a private
advisory that only the maintainers can see. Do not open a public issue or pull
request for a vulnerability.

Include what you found, how to reproduce it, and what an attacker gains. Kauak
is a small project without a security team, so there is no promised response
time. The advisory can credit you once it is published, if you want.

Fixes land on `main` and go out in the next release. Before 1.0 only the
latest release is supported.

Vulnerabilities in Herdr itself belong to the [Herdr project](https://github.com/herdrdev/herdr).

## What the bridge can do

Kauak's bridge (`packages/bridge/`) acts on your machine with your user's
rights. On every Herdr server it is connected to, it can:

- read what is on screen in any pane, and type text and keys into it
- create tabs, workspaces and git worktrees, and start agents in them
- open SSH connections to the machines saved as floors (with `BatchMode=yes`, so
  it never prompts), and run two small Python scripts there with `python3`
  (`packages/bridge/src/enrichers/context/context_remote.py`,
  `packages/bridge/src/enrichers/diffs/diffs_remote.py`) that read agent
  transcripts, git status and file contents

On this machine it also reads agent transcripts (`~/.claude/projects`,
`~/.codex/sessions`), agent command, skill and plugin files, and git status
and file contents in the checkouts the rooms are in.

Whoever controls the bridge can therefore run commands in your terminals.

## How it is protected

- The bridge listens on `127.0.0.1` only, unless you set `KAUAK_HOST`.
- Browsers let any web page open a WebSocket to `127.0.0.1`, so the bridge
  checks the `Origin` of each connection and accepts only pages served from
  `localhost`, `127.0.0.1` or `[::1]` (on any port), plus the hostnames you
  list in `KAUAK_ORIGINS`.
- Every message from a page goes through `parseClientMessage`
  (`packages/protocol/src/index.ts`), which checks its shape and sizes before
  the bridge acts on it. Messages it does not know are dropped, keys outside a
  short list of names (`enter`, `ctrl+c`…) are dropped, and text sent to a pane
  is cut at 64 KB per piece. The format is in
  [docs/protocol.md](docs/protocol.md).
- An SSH target typed in the page must look like `host`, `user@host` or an
  `~/.ssh/config` alias, and a branch name typed in build mode must look like
  one; neither can start with `-`, so they cannot pass options to `ssh` or
  `git`.
- The page that the bridge serves is static files from `dist/`, and requests
  cannot leave that folder. The one other thing it serves, `/appearances.json`,
  is the `.json` files of `~/.config/kauak/appearances` (or `KAUAK_APPEARANCES`)
  and the files `--appearance` names, each 64 KB at most, with their paths.
  Since those are this machine's, it answers only a request addressed to a
  hostname the WebSocket accepts pages from, and from such a page if it says
  where it comes from, so a site that points its own name at `127.0.0.1` (DNS
  rebinding) cannot read them.
- Appearance packages are declarative JSON, validated before use: fields the
  schema does not know, scripts among them, are refused. The bridge passes the
  installed ones on without reading them, and the page validates them exactly
  as it validates a package imported in the browser. A company banner is
  redrawn in the browser and kept only as a PNG data URL.

## Known limits

- There is no authentication. A connection without an `Origin` header (any
  program that is not a browser) is accepted, so on a machine shared with
  other users, they can connect to the bridge's port and drive your panes.
  Run Kauak on machines you do not share.
- Any page served from `localhost` or `127.0.0.1`, on any port, is trusted.
- `KAUAK_HOST=0.0.0.0` puts the bridge on your network with nothing but the
  origin check in front of it. Only do that on a network you trust.

Reports that break any of the protections above, or that let pane contents,
terminal titles, agent transcripts or imported packages run code in the page
(which would give them control of the bridge), are especially welcome.
