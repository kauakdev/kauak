# Releasing

Kauak is published to npm as `kauak`, a command-line package: people run
`npx kauak serve`, or `npm install -g kauak` and then `kauak serve`.

## What the package contains

`files` in package.json decides it:

- `bin/kauak.js`, the `kauak` executable (package.json `bin`), and `cli/`, the
  commands it runs
- `bridge/`, the bridge `kauak serve` starts, run as is (plain JavaScript, no
  build), with the two Python helpers it runs on remote floors over SSH
- `dist/`, the built office page the bridge serves, with
  `THIRD_PARTY_LICENSES.txt` for the packages bundled into it (written by
  `scripts/third-party-licenses.js` on every build)
- `package.json`, `README.md` and `LICENSE`, which npm always adds

Tests, test fixtures and type declarations are left out, and so is
`dist/kauak-banner.png`, which only the demo site uses (as its social preview).
The page's own packages (pixi.js, xterm.js) are devDependencies, since they are
bundled into `dist/`; the only runtime dependency is `ws`. A new directory
that the bridge or the CLI loads at runtime has to be added to `files`.

The package exposes no module: `exports` only lets tools read its
package.json, because importing the bridge would start a server.

## Checking the package

```bash
pnpm verify:pack
```

It packs the package as `npm publish` would (the `prepack` script type-checks
and builds the page first), checks the file list, installs the tarball with
`npm install`, `npm install -g` and `npx` into a temporary folder, and runs
`kauak --version`, `kauak --help`, `kauak serve` and bare `kauak` from each,
checking that the page, its files and the WebSocket answer. It never touches
your Herdr, saved floors, global packages or browser (stand-in openers record
what bare `kauak` would open), and it needs the npm registry to install `ws`.
CI runs it on every pull request, on Node 22 (the oldest version the package
supports) and Node 24 (the current LTS).

## Publishing a version

1. On an up-to-date `main` with green CI, run `pnpm install --frozen-lockfile`,
   `pnpm test` and `pnpm verify:pack`.
2. Set the version: `npm version <patch|minor|major>` (commits and tags
   `vX.Y.Z`).
3. Look at what will be uploaded: `npm publish --dry-run`.
4. Publish with `npm publish` (`publishConfig` sends it to the public npm
   registry), from an npm account with two-factor authentication on.
5. Push the commit and the tag: `git push --follow-tags`, then write the
   release notes on GitHub.
6. Check the published package: `npx kauak@latest --version` and
   `npx kauak@latest serve --demo`.

The first release differs: the version stays at 0.1.0, so skip `npm version`
and tag `v0.1.0` by hand after publishing. Before `npm publish --dry-run`,
remove the README's note under "Quick start" that Kauak is not on npm yet and
the "Publishing to npm" item under "Where it's going", and commit that, since
npm shows the README from the published package. The GitHub repository must be
public first, or the package page's repository, issue and image links will not
work. Publishing from GitHub Actions instead, with provenance, needs npm's
trusted publishing, which is set up on the package's npm settings once it
exists.
