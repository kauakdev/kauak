# Releasing

Kauak is published to npm as `kauak`, a command-line package: people run
`npx kauak serve`, or `npm install -g kauak` and then `kauak serve`.

## What the package contains

The package is `packages/kauak`, and `files` in its package.json decides what
goes in:

- `bin/kauak.js`, the `kauak` executable (package.json `bin`), and `cli/`, the
  commands it runs
- `bridge/`, the bridge `kauak serve` starts, as a bundle: `server.js` and
  `machine.js`, the two modules the CLI loads, built by Vite from
  `packages/bridge/src` into plain JavaScript for Node 22 (not minified, no
  source maps), with the two Python helpers it runs on remote floors over SSH
  beside them. It is bundled rather than copied because the bridge imports the
  protocol, `@kauak/protocol`, which is TypeScript and not on npm; the bundle
  inlines it, and leaves only `ws` and Node's own modules as imports.
  `prepack` makes it (`pnpm --filter @kauak/bridge bundle`,
  `packages/bridge/scripts/bundle.js`) and `postpack` removes it
- `dist/`, the built office page the bridge serves, with
  `THIRD_PARTY_LICENSES.txt` for the packages bundled into it (written by
  `scripts/third-party-licenses.js` on every build)
- `package.json`, `README.md` and `LICENSE`, which npm always adds. README and
  LICENSE are the repository's, copied in by `prepack`
  (`packages/kauak/scripts/assemble.js`)

Tests, test fixtures, TypeScript and type declarations are left out, and so is
`dist/kauak-banner.png`, which only the demo site uses (as its social preview).
The page's own packages (pixi.js, xterm.js) are devDependencies, since they are
bundled into `dist/`; the only runtime dependency is `ws`. No dependency or
import in the package may be a workspace package (`@kauak/*`, `workspace:`),
since npm cannot install one. A new directory that the CLI loads at runtime has
to be added to `files`.

The package exposes no module: `exports` only lets tools read its
package.json, because importing the bridge would start a server.

## Checking the package

```bash
pnpm verify:pack
```

It packs the package as `npm publish` would (the `prepack` script type-checks
the protocol and the page, builds the page and bundles the bridge first),
checks the file list, installs the tarball with `npm install`, `npm install -g`
and `npx` into a temporary folder, checks that no installed file imports a
workspace package, and runs `kauak --version`, `kauak --help`, `kauak serve`
and bare `kauak` from each, checking that the page, its files and the
WebSocket answer. It never touches
your Herdr, saved floors, global packages or browser (stand-in openers record
what bare `kauak` would open), and it needs the npm registry to install `ws`.
CI runs it on every pull request, on Node 22 (the oldest version the package
supports) and Node 24 (the current LTS).

## Publishing a version

1. On an up-to-date `main` with green CI, run `pnpm install --frozen-lockfile`,
   `pnpm test` and `pnpm verify:pack`. Steps 3 to 5 run in `packages/kauak`.
2. Write the release notes: in `CHANGELOG.md`, the Unreleased section becomes
   the version's (`## [X.Y.Z] - YYYY-MM-DD`), under a new, empty Unreleased.
   Commit that.
3. Set the version: `npm version <patch|minor|major> --no-git-tag-version`.
   npm also re-expands package.json's compact layout, so run `pnpm format`
   from the repository's root before committing, or `pnpm lint` fails. Below
   the root, npm only changes package.json and neither commits nor tags, so do
   both yourself: `git commit -am X.Y.Z` and `git tag -a vX.Y.Z -m X.Y.Z`.
4. Look at what will be uploaded: `npm publish --dry-run`.
5. Publish with `npm publish` (`publishConfig` sends it to the public npm
   registry), from an npm account with two-factor authentication on.
6. Push the commits and the tag: `git push --follow-tags`, then make a GitHub
   release for the tag with the version's section of `CHANGELOG.md` as its
   notes.
7. Check the published package: `npx kauak@latest --version` and
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
