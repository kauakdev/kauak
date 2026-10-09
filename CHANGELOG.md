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

- Floors saved before the rename, in `~/.config/agent-office/machines.json`, are
  copied to `~/.config/kauak/machines.json` once, the first time the bridge
  starts without one, and the bridge says so. The old file is left as it was
  and is not read after that.
- Appearance settings saved in the browser before the rename, under
  `agent-office.plugins.v1`, are copied to `kauak.appearance.v1` once, the first
  time the page loads without it. The included packages' ids change from
  `agent-office.classic`, `agent-office.orbital` and `agent-office.basecamp` to
  `kauak.classic`, `kauak.orbital` and `kauak.basecamp`, and the copy keeps
  them selected. The old key is left as it was and is not read after that. An
  imported package may no longer use an id that starts with `kauak.`, as one
  starting with `agent-office.` already could not.
- The page's other preferences saved in the browser before the rename, under
  `agent-office.floor`, `agent-office.feed-hidden`, `agent-office.build.agent`,
  `agent-office.radio` and `agent-office.panel-width`, are copied to the same
  names under `kauak.` once, the first time the page reads each without its new
  key. The old keys are left as they were and are not read after that.
- The page's text about a floor (why it is not answering or still empty, "Focus
  in …", "focused in …" and the build form's hints) names what runs that floor,
  as the bridge reports it, instead of always saying Herdr. With Herdr it reads
  as before.
- Running Kauak from a checkout (`pnpm dev`, `pnpm start`, `pnpm test`) needs
  Node 22.18 or newer, which runs the bridge's TypeScript as it is. The npm
  package still runs on any Node 22.

### Removed

- The `AGENT_OFFICE_*` environment variables from before the rename. Use their
  `KAUAK_*` names: `KAUAK_PORT`, `KAUAK_HOST`, `KAUAK_ORIGINS`, `KAUAK_CONFIG`
  and `KAUAK_SSH`.
- The `terminal.provider` capability of appearance packages, and the Herdr
  package that declared it. The bridge never read them: the terminals the office
  shows come from the bridge's runtime adapters. A package that declares
  `terminal.provider` is refused like any other unknown capability, and a saved
  selection of it is dropped.

[Unreleased]: https://github.com/agustinrbeltran/kauak/commits/main
