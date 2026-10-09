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

### Removed

- The `AGENT_OFFICE_*` environment variables from before the rename. Use their
  `KAUAK_*` names: `KAUAK_PORT`, `KAUAK_HOST`, `KAUAK_ORIGINS`, `KAUAK_CONFIG`
  and `KAUAK_SSH`.

[Unreleased]: https://github.com/agustinrbeltran/kauak/commits/main
