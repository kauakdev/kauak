// A Vite plugin that writes THIRD_PARTY_LICENSES.txt next to the built page:
// every npm package bundled into the page, with its license text. Minifying
// keeps only some of their license comments, and the built page is what the
// npm package and the demo site hand out.

import fs from "node:fs";
import path from "node:path";

export const FILE_NAME = "THIRD_PARTY_LICENSES.txt";

// The package a bundled module comes from: the folder after its last node_modules.
const PACKAGE_DIR = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/;
// LICENSE, LICENSE.md, licence.txt, COPYING...
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i;
const RULE = "-".repeat(72);

export function thirdPartyLicenses() {
  return {
    name: "kauak:third-party-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const dirs = new Set();
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        for (const id of Object.keys(file.modules)) {
          const dir = PACKAGE_DIR.exec(id.replace(/^\0/, ""))?.[1];
          if (dir) dirs.add(dir);
        }
      }
      const entries = [...dirs].map(licenseEntry).sort((a, b) => a.title.localeCompare(b.title));
      const source = `The kauak office page (index.html and assets/) bundles the third-party
packages below. Each is listed with the license it is distributed under.
${entries.map((e) => `\n${RULE}\n${e.title}\n\n${e.text}\n`).join("")}`;
      this.emitFile({ type: "asset", fileName: FILE_NAME, source });
    },
  };
}

function licenseEntry(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : "see its package.json";
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  return {
    title: `${pkg.name} ${pkg.version} (${license})`,
    text: file ? fs.readFileSync(path.join(dir, file), "utf8").trim()
      // A few packages publish no license file; their package.json is all there is.
      : `The package includes no license file. Its package.json gives the license as ${license}${author ? ` and the author as ${author}` : ""}.`,
  };
}
