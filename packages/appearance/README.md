# @kauak/appearance

Appearance packages: the bundled JSON looks in `packages/`, and the contracts
and registry that validate them in `src/`. No dependencies, and no DOM in the
registry. Private: the page (`@kauak/web`) imports it by name and bundles it.
The settings dialog is the page's (`packages/web/src/appearance/`); what it
saves goes through `loadPreferences` and `savePreferences` here, under
`kauak.appearance.v1`. See the
[appearance and banner guide](../../docs/appearance/README.md).
