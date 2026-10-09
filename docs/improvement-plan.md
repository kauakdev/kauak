# Architecture improvement plan

Status: proposal, October 2026. Nothing here changes behaviour; every step is
a refactor verified by the checks CONTRIBUTING.md already lists.

## Where Kauak stands

The important boundary already exists. The page and the bridge speak the
Kauak protocol, Herdr is behind `machine.js` and `herdr.js`, the tests run a
real bridge against a fake Herdr and check that nothing of Herdr's leaks, and
the docs explain all of it. That is Ports & Adapters in substance. The plan
below keeps that and fixes what is around it.

What gets in the way today (measured on `main`, 11k lines of source):

| Finding | Evidence |
|---|---|
| Seven top-level code folders with implicit relationships | `bin/`, `cli/`, `bridge/`, `shared/`, `plugins/`, `web/`, `scripts/`; `web/src/types.ts` imports `../../bridge/protocol`; `web/src/plugins/catalog.ts` imports `../../../plugins/*.json` and `../../../shared/plugins` |
| "plugins" means three different things | `plugins/` (JSON appearance packages), `shared/plugins/` (contracts and validation), `web/src/plugins/` (settings UI, backgrounds, banner) |
| Half the code is not type-checked | `tsconfig.json` includes only `web/src`; `bridge/` and `cli/` are plain JS; the protocol's types (`protocol.d.ts`) and its rules (`protocol.js`) are two hand-written files that can drift |
| The bridge is a side-effecting module | `bridge/server.js` listens on import, keeps module-level mutable maps (`machines`, `contexts`, `diffs`, `inputQueues`), reads `process.env` at load; `cli/commands/serve.js` has to `await import()` it to start it; tests must spawn a process |
| Configuration is scattered | `process.env` is read in `server.js`, `machine.js`, `context.js`; every variable has an `AGENT_OFFICE_*` fallback; 15 files still carry `agent-office` storage keys and ids |
| One scene class does everything | `web/src/scene.ts` is 1008 lines and 32 public members: layers, camera, hit testing, selection, build-mode overlay, printer animation, tooltip DOM, theme to CSS variables |
| The page is wired by hand | `main.ts` creates 12 objects and connects them with ~30 callbacks; state (`machines`, `snapshots`, `current`) lives in closure variables |
| Styling and markup are a global contract | 458 lines of CSS inline in `web/index.html`; 13 TypeScript files call `document.getElementById` on ids defined there |
| The page has almost no tests | `web/src/stations.test.mjs` compiles one file with `tsc` into a temp dir to test it; `layout.ts`, `roam.ts`, `floors.ts`, `iso.ts` are pure and untested |
| Speculative extension points | `shared/plugins/contracts.ts` declares a `terminal.provider` capability the bridge never reads; the guide says importing providers is "not implemented" |
| No formatter, linter or boundary check | Nothing enforces "Herdr knowledge lives in two files" or "registry.ts has no Pixi, DOM, bridge imports" apart from review |
| Workspace in name only | `pnpm-workspace.yaml` declares no packages; agent-tooling files are tracked (`.agents/`, `.claude/skills/`, `skills-lock.json`) and `.claude/worktrees/` is only excluded locally |

## Target shape

A pnpm workspace with one published package and a handful of private ones,
as pi-mono does, sized for an 11k-line project rather than a 150k-line one.

```
packages/
  protocol/     @kauak/protocol    the Kauak protocol: types and rules in one TS module, no deps
  bridge/       @kauak/bridge      Node. Core (floors, router, input queue, build) + ports + adapters
    src/core/                      Kauak terms only; never imports a runtime
    src/ports/                     Runtime, Enricher, Transport interfaces
    src/runtimes/herdr/            today's machine.js, herdr.js, remote.js, the two .py scripts
    src/enrichers/context/         today's context.js
    src/enrichers/diffs/           today's diffs.js
    src/enrichers/commands/        today's commands.js
    src/transport/ws.ts            the WebSocket server and static page serving
    src/server.ts                  createBridge(config, { runtimes, enrichers }) → { listen, close }
  appearance/   @kauak/appearance  contracts + registry + the bundled JSON packages (shared/plugins + plugins/)
  web/          @kauak/web         the page, Vite; feature folders (below)
  kauak/        kauak              the npm package: bin, cli, resolveConfig, bundles bridge + web/dist
scripts/                           repo tooling (verify-pack, licenses, check-boundaries)
docs/
```

Dependency direction, enforced by a script in CI:

```
kauak ──▶ bridge ──▶ protocol ◀── web ──▶ appearance
          core ──▶ ports ◀── runtimes/herdr, enrichers/*
```

Rules the script checks: `protocol` imports nothing from the workspace;
`bridge/src/core` never imports `runtimes/` or `enrichers/`; `web` imports
only `protocol` and `appearance`; `appearance/registry` imports no DOM, Pixi
or bridge module. These are the rules the docs already state in prose.

Patterns used, and why only these:

- **Ports & Adapters** in the bridge, which it already is. Naming the two
  ports (`Runtime` = the "face of Machine" the protocol doc describes;
  `Enricher` = the "three trackers that add what Herdr does not report")
  makes the boundary a type instead of a comment.
- **Microkernel, lightly**: enrichers register with the core and decorate
  snapshots. No dynamic loading, no manifests for them; a list in `server.ts`.
- **Facade**: `OfficeScene` stays as the page's single entry to rendering, but
  composes `Camera`, `FloorRenderer`, `Picker`, `PrinterAnimator`, `Tooltip`.
- **Observer**: one small `AppState` store in the page (machines, snapshots,
  current floor, selection) that HUD, scene, panel and elevator subscribe to.
  No framework.
- **Adapter**: `DemoBridge` already implements `BridgeApi`; it moves next to
  `Bridge` and stays the way the demo build works.

Not doing: DDD layers or use cases (there is no domain logic to protect from
CRUD), a DI container, event sourcing, publishing internal packages, a UI
framework. Each would cost more than the whole codebase is worth.

## Decisions to make first

1. **Bridge in TypeScript, built with `tsc`.** Today "plain JS, no build" is a
   feature, but the package already needs a build for `dist/`, and the
   protocol can only be a single source of truth if the bridge consumes TS.
   Alternative: keep JS and turn on `checkJs` with JSDoc. Recommended: TS.
2. **Protocol validation stays hand-written**, but in the same file as the
   types, using type guards so a message type without a parser does not
   compile. Alternative: TypeBox or Zod (pi uses TypeBox). Recommended:
   hand-written, to keep zero runtime deps; revisit if the protocol grows.
3. **One published package.** `kauak` stays the only thing on npm; `@kauak/*`
   are `private: true` until someone outside needs one. This avoids the
   version-sync tooling pi had to write.
4. **Tests**: `node:test` stays for bridge and CLI (they spawn processes
   anyway). The page gets Vitest, so TypeScript modules are tested without
   the `tsc`-to-temp-dir trick. Alternative: Vitest everywhere.
5. **Drop the `AGENT_OFFICE_*` and `agent-office.*` names** in a 0.2.0 with a
   one-time migration of the config file and browser storage, and a line in
   the changelog. They double every config read today.

## Phases

Each phase is one or a few pull requests, all behaviour-preserving, each
verified by `pnpm typecheck`, `pnpm build`, `pnpm build:demo`, `pnpm test`,
`pnpm verify:pack` and a look at the office in the browser. Order matters:
each phase makes the next one mechanical.

### Phase 0: tooling before moving anything

- Add Biome (format + lint, one dev dependency), `.editorconfig`, and run the
  formatter once in its own commit.
- Add `scripts/check-boundaries.mjs` with today's rules (Herdr only in
  `machine.js`/`herdr.js`/`remote.js`; `registry.ts` free of DOM/Pixi) so the
  refactor cannot regress them; wire it into CI.
- Add `.claude/worktrees/` to `.gitignore`; stop tracking `.agents/`,
  `.claude/skills/`, `skills-lock.json` or move them under a documented
  `tooling/` folder. A public repo should not ship one contributor's agent
  setup.
- Add `CHANGELOG.md`, issue and pull-request templates.

### Phase 1: workspace skeleton (pure moves)

- `git mv` into `packages/*` as drawn above; one `package.json` per package,
  `pnpm-workspace.yaml: packages: ["packages/*"]`, root scripts run `-r`.
- `packages/kauak` keeps `bin`, `files`, `prepack`; `dist/` is built into it
  (Vite `outDir`) so `verify:pack` keeps passing unchanged.
- Fix the paths that depend on file position: `server.js` finding `../dist/`,
  `remote.js` reading the Python scripts beside it, Vite `root`, the JSON
  imports in `catalog.ts`.
- Update `docs/architecture.md`, `docs/protocol.md`, CONTRIBUTING "Layout".

### Phase 2: protocol as one TypeScript module

- `packages/protocol/src/index.ts`: the types from `protocol.d.ts` and the
  parsers from `protocol.js` together; `parseClientMessage` returns
  `ClientMessage | null` and the compiler checks every variant is handled.
- Bridge and page import `@kauak/protocol`; delete `protocol.d.ts` and
  `web/src/types.ts`.
- Port `protocol.test.mjs` as is.

### Phase 3: bridge without side effects

- Convert `bridge/*.js` to TS (mechanical; the `.d.ts` already describes most
  shapes).
- `resolveConfig(env, flags)` in `packages/kauak` produces one frozen config
  object (port, host, origins, config path, socket path, ssh binary). No
  other file reads `process.env`.
- `createBridge(config, deps)` returns `{ listen(), close(), floors }`; the
  CLI calls it. Module-level maps become fields of a `Bridge` or
  `FloorRegistry` class.
- `server.test.mjs` can now start the bridge in-process; the fake Herdr stays.

### Phase 4: name the ports

- `ports/runtime.ts`: the interface Machine already satisfies (`id`, `label`,
  `ssh`, `info`, `snapshot`, `state`, events, `start/stop/refresh`, the eight
  operations). `runtimes/herdr/` implements it.
- `ports/enricher.ts`: `start(floor)`, `stop()`, `decorate(snapshot)`,
  `on("change")`. Context meters, printers and slash commands become
  enrichers the core iterates over instead of three hard-coded maps.
- Message handling: the `if/else` chain in the connection handler becomes a
  `handlers: Record<ClientMessage["type"], Handler>` map; input queueing and
  build mode get their own modules (they mostly are already).
- Extend `check-boundaries` to the new rule: `core/` never imports
  `runtimes/` or `enrichers/`.

### Phase 5: the page

In this order, each its own PR:

1. **CSS out of `index.html`** into `web/src/styles/*.css`, one per feature,
   imported by the module that owns the markup. Vite bundles them the same.
2. **Feature folders**: `app/` (main, state), `bridge/` (ws, demo, api),
   `office/` (layout, iso, scene and its parts, props, character, roam,
   shadow), `floors/` (floors, elevator), `terminal/` (panel, slash),
   `printers/` (prints, printout), `hud/`, `radio/` (radio, stations),
   `appearance/` (settings, background, banner, catalog).
3. **`AppState` store**: machines, snapshots, current floor, selected pane,
   with `subscribe`. `main.ts` shrinks to construction and a few bindings;
   the HUD, panel and elevator read state instead of being pushed it.
4. **Split `OfficeScene`** into `Camera`, `FloorRenderer`, `Picker`,
   `PrinterAnimator`, `Tooltip`; the facade keeps today's public methods so
   `main.ts` and `settings.ts` do not change in the same PR.
5. **Unit tests** with Vitest for `layout`, `roam` (A*), `floors`, `iso`,
   `prints`; they take a snapshot in and return data, no DOM needed.

### Phase 6: appearance

- `packages/appearance`: `contracts.ts`, `registry.ts`, the four JSON
  packages, their tests. The settings UI stays in `web/src/appearance/`.
- Rename the vocabulary from "plugins" to "appearance packages" in code and
  docs; keep the word plugin only if a real plugin system (code, not data)
  arrives later.
- Remove `terminal.provider` from the contracts and `plugins/herdr.json`.
  The bridge never reads them, and a runtime is a `Runtime` adapter in the
  bridge (Phase 4), not a browser-side manifest.
- Storage key `agent-office.plugins.v1` → `kauak.appearance.v1` with a
  one-time copy.

### Phase 7: clean-up and release

- Drop `AGENT_OFFICE_*` and `~/.config/agent-office` fallbacks after the
  migration in Phase 3 has shipped in one release.
- Audit page copy that names Herdr where the runtime name should come from
  `MachineInfo.runtime` (6 files today).
- Rewrite `docs/architecture.md` around packages and ports; tag 0.2.0.

## What a contributor sees afterwards

- One folder per concern, each with a README of five lines and a
  `package.json` that says what it depends on.
- "Where does a new message go" has one answer: `packages/protocol`, then the
  handler map in `bridge/src/core`, then the page's `bridge/` folder.
- "Where does a new runtime go" has one answer: `bridge/src/runtimes/<name>/`
  implementing `Runtime`, and CI fails if it touches `core/`.
- "Where does a new office look go" has one answer: a JSON file in
  `packages/appearance/packages/`.
- `pnpm check` runs format, lint, boundaries, types; `pnpm test` runs both
  runners; `pnpm verify:pack` still proves the tarball works.

## Risks

- **Packaging regressions** while moving files: `files` in `package.json`,
  `import.meta.url` paths and the Vite root all assume today's layout.
  `verify:pack` catches most; run it after every move.
- **Churn in open branches**: the three worktrees under `.claude/worktrees`
  will conflict with Phase 1. Land or close them first.
- **Scope creep**: every phase is tempting to combine with a feature. Keep
  the refactor skill's rule: one change per PR, behaviour unchanged, tests
  green before and after.
