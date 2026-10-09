// readAppearances: the appearance packages installed on this machine, as the
// page gets them from /appearances.json. The bridge reads the files and parses
// them as JSON; what is in them is the page's to validate.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAppearances } from "./appearances.ts";

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-appearances-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const HARBOR = { schemaVersion: 1, id: "example.harbor", name: "Harbor office" };

test("a folder that does not exist: nothing installed, and where to put packages", async (t) => {
  const dir = path.join(folder(t), "appearances");
  assert.deepEqual(await readAppearances({ appearanceDir: dir, appearanceFiles: [] }), { dir, packages: [] });
});

test("every .json file in the folder, in name order and whatever the extension's case, parsed as it is", async (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, "harbor.json"), JSON.stringify(HARBOR));
  fs.writeFileSync(path.join(dir, "alpine.json"), '{ "id": "example.alpine" }');
  fs.writeFileSync(path.join(dir, "Coast.JSON"), '{ "id": "example.coast" }');
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a package");
  fs.writeFileSync(path.join(dir, ".hidden.json"), "{}");
  fs.mkdirSync(path.join(dir, "folder.json"));
  assert.deepEqual(await readAppearances({ appearanceDir: dir, appearanceFiles: [] }), {
    dir,
    packages: [
      { file: path.join(dir, "Coast.JSON"), package: { id: "example.coast" } },
      { file: path.join(dir, "alpine.json"), package: { id: "example.alpine" } },
      { file: path.join(dir, "folder.json"), error: "not a file" },
      { file: path.join(dir, "harbor.json"), package: HARBOR },
    ],
  });
});

test("the --appearance files come after the folder's, each file once", async (t) => {
  const dir = folder(t);
  const elsewhere = folder(t);
  fs.writeFileSync(path.join(dir, "harbor.json"), JSON.stringify(HARBOR));
  fs.writeFileSync(path.join(elsewhere, "mine.json"), '{ "id": "example.mine" }');
  const files = [path.join(elsewhere, "mine.json"), path.join(dir, "harbor.json"), path.join(elsewhere, "mine.json")];
  assert.deepEqual(await readAppearances({ appearanceDir: dir, appearanceFiles: files }), {
    dir,
    packages: [
      { file: path.join(dir, "harbor.json"), package: HARBOR },
      { file: path.join(elsewhere, "mine.json"), package: { id: "example.mine" } },
    ],
  });
});

test("a file that is not JSON, too big or missing is passed on as an error beside its name, and the rest still load", async (t) => {
  const dir = folder(t);
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  fs.writeFileSync(path.join(dir, "huge.json"), `{"pad":"${"x".repeat(70 * 1024)}"}`);
  fs.writeFileSync(path.join(dir, "harbor.json"), JSON.stringify(HARBOR));
  const missing = path.join(dir, "gone.json");
  const { packages } = await readAppearances({ appearanceDir: dir, appearanceFiles: [missing] });
  assert.deepEqual(
    packages.map((p) => [path.basename(p.file), "package" in p ? "ok" : p.error.replace(/\(.*\)/, "(…)")]),
    [
      ["broken.json", "not valid JSON (…)"],
      ["harbor.json", "ok"],
      ["huge.json", "71 KB; a package is 64 KB at most"],
      ["gone.json", "no such file"],
    ],
  );
});

test("a file is read on each call, so an edit shows without a restart", async (t) => {
  const dir = folder(t);
  const file = path.join(dir, "harbor.json");
  fs.writeFileSync(file, JSON.stringify(HARBOR));
  const settings = { appearanceDir: dir, appearanceFiles: [] };
  assert.deepEqual((await readAppearances(settings)).packages, [{ file, package: HARBOR }]);
  fs.writeFileSync(file, JSON.stringify({ ...HARBOR, name: "Harbor, revised" }));
  assert.deepEqual((await readAppearances(settings)).packages, [{ file, package: { ...HARBOR, name: "Harbor, revised" } }]);
});
