# @kauak/bridge

The bridge between Herdr and the office page, plain JavaScript in `src/` that
imports `@kauak/protocol` and `ws`; `machine.js` and `herdr.js` are the Herdr
adapter. Private: `pnpm --filter @kauak/bridge bundle` bundles it for the
`kauak` npm package. Run it with `pnpm bridge`. See
[How Kauak works](../../docs/architecture.md) and [the Kauak protocol](../../docs/protocol.md).
