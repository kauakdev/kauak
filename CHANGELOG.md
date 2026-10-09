# Changelog

What changes for people who run Kauak, version by version, newest first. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

A pull request that changes what people see, run or configure adds a line under
Unreleased (Added, Changed, Deprecated, Removed, Fixed or Security). Releasing
turns Unreleased into the new version's section, as
[docs/releasing.md](docs/releasing.md) describes.

## [Unreleased]

### Changed

- The included appearance packages' ids are `kauak.classic`, `kauak.orbital`
  and `kauak.basecamp`, and an imported package may no longer use an id that
  starts with `kauak.`.
- The page's text about a floor (why it is not answering or still empty, "Focus
  in …", "focused in …" and the build form's hints) names what runs that floor,
  as the bridge reports it, instead of always saying Herdr. With Herdr it reads
  as before.
- Running Kauak from a checkout (`pnpm dev`, `pnpm start`, `pnpm test`) needs
  Node 22.18 or newer, which runs the bridge's TypeScript as it is. The npm
  package still runs on any Node 22.

### Removed

- The `terminal.provider` capability of appearance packages, and the Herdr
  package that declared it. The bridge never read them: the terminals the office
  shows come from the bridge's runtime adapters. A package that declares
  `terminal.provider` is refused like any other unknown capability, and a saved
  selection of it is dropped.

### Fixed

- Idle agents who stand around a room on a break keep the same space from the
  furniture and the room's edges on every side. Toward the front of the room they
  used to stand closer.
- The roster names each group of rooms as the office names its wing. A room with
  no repository and no folder to go by, only a label, was listed under "loose"
  while the office put it in a wing named after its label.

[Unreleased]: https://github.com/agustinrbeltran/kauak/commits/main
