# @kauak/web

The office page, TypeScript with PixiJS and xterm.js, built with Vite into
`packages/kauak/dist` (the demo into `dist-demo/`). Depends on
`@kauak/appearance`, and on `@kauak/protocol` for the protocol's types, never
the bridge. `src/` has one folder per feature (`app/`, `bridge/`, `office/`,
`floors/`, `terminal/`, `printers/`, `hud/`, `radio/`, `appearance/`), each
stylesheet beside the module that owns it; its tests run on Vitest. Private: it
ships as the built page in `kauak`. Run it with `pnpm dev`. See
[How Kauak works](../../docs/architecture.md).
