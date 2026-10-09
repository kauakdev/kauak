# @kauak/protocol

The Kauak protocol in one TypeScript module, `src/index.ts`: the messages the
bridge and the page exchange, and `parseClientMessage`, which the bridge checks
every message from a page with. It imports nothing, so both sides import it by
name. Private: the npm package carries it inlined in the bridge's bundle. See
[the Kauak protocol](../../docs/protocol.md).
