# Contributing to Kauak

Thanks for helping. Bug reports, small fixes and new appearance packages are
the easiest to take. For anything bigger, open an issue first so we can agree
on the shape before you spend time on it.

## Set up

You need Node.js 22.18 or newer and [pnpm](https://pnpm.io) (the repository
is locked with `pnpm-lock.yaml`). The bridge runs from its source, and the
protocol it imports is TypeScript, which Node runs by stripping its types from
22.18 on, so there is no build or watch step to run it or the tests. The npm
package still runs on any Node 22, because it carries the bridge as plain
JavaScript. To see real agents you also need [Herdr](https://herdr.dev)
running; without it, the demo mode simulates everything.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the bridge on port 7788 and Vite on
http://localhost:5178, which reloads the page as you edit `packages/web/`. The
bridge does not reload: restart `pnpm dev` after changing `packages/bridge/` or
`packages/protocol/`. Open http://localhost:5178/?demo for simulated agents.

The bridge drives your real Herdr: it can type into your panes and create
tabs and worktrees. While you work on it, consider pointing it at a separate
Herdr session with `HERDR_SOCKET_PATH`, and if port 7788 is taken (by your
everyday Kauak, say), run a second bridge with
`KAUAK_PORT=7799 VITE_BRIDGE_PORT=7799 pnpm dev`.

## Layout

A pnpm workspace of five packages, each with its own `package.json` and README:

- `packages/protocol/` (`@kauak/protocol`): the Kauak protocol, its types and
  the checks the bridge runs on every message from a page, in one TypeScript
  module, `src/index.ts`. It imports nothing, so the bridge and the page both
  import it by name.
- `packages/bridge/` (`@kauak/bridge`): the Node bridge, in `src/`, plain ESM
  JavaScript with no build step. Its runtime dependencies are `ws` and the
  protocol. `machine.js` and `herdr.js` are the Herdr adapter, the only files
  that speak Herdr's API. `scripts/bundle.js` bundles it for the npm package.
- `packages/kauak/` (`kauak`, the npm package): `bin/kauak.js` and `cli/`, the
  `kauak` command. A new command is one module in `cli/commands/` and one entry
  in `COMMANDS` in `cli/main.js`, whose opening comment says what the module
  exports. The page is built into its `dist/`.
- `packages/web/` (`@kauak/web`): the page, TypeScript with PixiJS and
  xterm.js, built with Vite. `src/demo.ts` stands in for the bridge in the
  demo.
- `packages/appearance/` (`@kauak/appearance`): appearance packages (in
  `packages/`) and their validation (in `src/`). See the
  [plugin and banner guide](docs/plugins/README.md).

`scripts/` holds the repository's tooling: the boundary check, the package
check and the page's license list.

[docs/architecture.md](docs/architecture.md) explains how the pieces fit.

## Changing what the page and the bridge say

The page and the bridge talk only in the Kauak protocol: its types and its
checks are in `packages/protocol/src/index.ts` (`@kauak/protocol`), and its
reference in [docs/protocol.md](docs/protocol.md). The bridge drops any message
from a page that the checks do not know, so a new or changed message starts in
`packages/protocol` (a message from the page does not compile until
`parseClientMessage` has a parser for it), then the bridge
(`packages/bridge/src/server.js`), then `packages/web/src/demo.ts`, so the demo
keeps working, and the reference. Herdr's own fields and methods stay in the
adapter.

## Before you open a pull request

Run the checks, in this order (the CLI's page tests skip until the page is
built):

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm build:demo
pnpm test
pnpm verify:pack
```

`pnpm check` runs `pnpm lint`, `pnpm check:boundaries` and `pnpm typecheck`.
`pnpm lint` runs [Biome](https://biomejs.dev) (`biome.jsonc`) over the
JavaScript, TypeScript, JSON and CSS, checking formatting and lint rules
without changing anything; `pnpm format` rewrites files to its style, and
`.editorconfig` tells your editor the same. Markdown and the Python helpers are
formatted by hand.

`pnpm check:boundaries` (`scripts/check-boundaries.mjs`) keeps the pieces
apart: only the Herdr adapter (`packages/bridge/src/machine.js`,
`packages/bridge/src/herdr.js`, `packages/bridge/src/remote.js`) imports
`herdr.js` or names Herdr's methods, the trackers do not import the adapter,
`packages/protocol` imports nothing (no other package, no Node or DOM) and the
others import it by its name, `packages/appearance/src/registry.ts` imports
nothing but its contracts and uses no DOM, the page imports the protocol and
the appearance packages but nothing of the bridge or the CLI, and the bridge
and the CLI import nothing from the page. When a file moves, update the rules
at the top of the script.

`pnpm test` runs `node --test` in each package and in `scripts/`, which finds
every `*.test.mjs`. Tests use Node's built-in runner (`node:test` with
`node:assert/strict`) and sit next to the code they test. The bridge's tests
run against a stand-in Herdr
(`packages/bridge/src/fixtures/fake-herdr.mjs`), so they need no Herdr
installed.

`pnpm verify:pack` builds the npm package, installs it with `npm install`,
`npm install -g` and `npx` in a temporary folder, and runs `kauak serve` from
each. It needs the npm registry, and matters most when you change what the
package ships: a new folder that the CLI loads at runtime has to be added to
`files` in `packages/kauak/package.json`. The bridge goes in as a bundle of
`src/server.js` and `src/machine.js` with the protocol inlined, plus the Python
helpers. Packing writes that bundle and copies README and LICENSE into
`packages/kauak/`, and removes them afterwards; a `packages/kauak/bridge/` left
behind by an interrupted pack is safe to delete.

CI (`.github/workflows/ci.yml`) runs all of them on Node 22 and 24, for every
pull request and push to `main`.

Then check the change in the browser: against Herdr if it touches the bridge,
and in the demo.

Some conventions:

- Match the code around you: its naming, its comment style and how much it
  comments. Comments say why, not what.
- Do not add dependencies without a good reason, and give that reason in the
  pull request.
- Update the README or `docs/` when you change behavior they describe, and add
  a line to [CHANGELOG.md](CHANGELOG.md) under Unreleased when the change is
  one people who run Kauak would notice.
- Keep one change per pull request. Titles are imperative and in sentence case,
  like the existing history ("Let the terminal panel scroll back through a
  pane's history").
- In the description, explain what changed and why, and list what you ran to
  check it. Add a screenshot for visual changes.

## Releases

Maintainers publish to npm as [docs/releasing.md](docs/releasing.md) describes.

## Security

Do not report vulnerabilities in public issues. See [SECURITY.md](SECURITY.md).

## License

Kauak is licensed under the [Apache License 2.0](LICENSE). Unless you say
otherwise, what you contribute is licensed under the same terms (section 5 of
the license).
