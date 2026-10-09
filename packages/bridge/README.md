# @kauak/bridge

The bridge between Herdr and the office page, TypeScript in `src/` that Node
22.18 or newer runs as it is, importing `@kauak/protocol` and `ws`. `core/`
speaks only Kauak and knows a floor through the ports in `ports/` (`Runtime`,
`Enricher`); `runtimes/herdr/` is the Herdr adapter, `enrichers/` the context
meters, printers and slash commands, and `ssh/` runs their helpers on remote
floors. Loading it starts nothing: `resolveConfig` (`config.ts`) makes its
settings and `createBridge` (`server.ts`, which puts the pieces together) the
bridge, which `kauak serve` and `main.ts` start. Private:
`pnpm --filter @kauak/bridge bundle` bundles it for the `kauak` npm package.
Run it with `pnpm bridge`. See
[How Kauak works](../../docs/architecture.md) and [the Kauak protocol](../../docs/protocol.md).
