# @kauak/bridge

The bridge between Herdr and the office page, TypeScript in `src/` that Node
22.18 or newer runs as it is, importing `@kauak/protocol` and `ws`; `machine.ts`
and `herdr.ts` are the Herdr adapter. Private:
`pnpm --filter @kauak/bridge bundle` bundles it for the `kauak` npm package.
Run it with `pnpm bridge`. See
[How Kauak works](../../docs/architecture.md) and [the Kauak protocol](../../docs/protocol.md).
