# @kauak/bridge

The bridge between Herdr and the office page, plain JavaScript in `src/` with
`ws` as its only dependency; `machine.js` and `herdr.js` are the Herdr adapter.
Private: the `kauak` npm package carries a copy of `src/`. Run it with
`pnpm bridge`. See [How Kauak works](../../docs/architecture.md) and
[the Kauak protocol](../../docs/protocol.md).
