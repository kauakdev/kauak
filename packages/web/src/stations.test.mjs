import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// Stations whose operators explicitly allow third-party players, with conditions
// Kauak meets. A station joins the dial only after it's added here too.
const ALLOWED = [{ name: "CLIAMP Lofi", url: "https://radio.cliamp.stream/lofi/stream", site: "https://cliamp.stream" }];

// Compile the station list on its own; no browser or audio needed.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kauak-radio-tests-"));
const compiler = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const build = spawnSync(
  process.execPath,
  [
    compiler,
    path.join(import.meta.dirname, "stations.ts"),
    "--outDir",
    temp,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--strict",
    "--skipLibCheck",
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  fs.rmSync(temp, { recursive: true });
  throw new Error(build.stdout + build.stderr);
}
const { STATIONS } = createRequire(import.meta.url)(path.join(temp, "stations.js"));
test.after(() => fs.rmSync(temp, { recursive: true }));

test("the dial carries exactly the allowed stations, each with its credit link", () => {
  assert.deepEqual(
    STATIONS.map(({ name, url, site }) => ({ name, url, site })),
    ALLOWED,
  );
});
test("each station streams over https from its credited site's domain, at its own spot on the band", () => {
  for (const s of STATIONS) {
    const stream = new URL(s.url),
      site = new URL(s.site);
    assert.equal(stream.protocol, "https:");
    assert.equal(site.protocol, "https:");
    assert.ok(
      stream.host === site.host || stream.host.endsWith(`.${site.host}`),
      `${s.name} streams from ${stream.host}, not ${site.host}`,
    );
    assert.ok(s.freq >= 87.5 && s.freq <= 108, `${s.name} is off the band`);
  }
  assert.equal(new Set(STATIONS.map((s) => s.freq)).size, STATIONS.length);
});
test("the radio plays only what stations.ts lists", () => {
  assert.doesNotMatch(fs.readFileSync(path.join(import.meta.dirname, "radio.ts"), "utf8"), /https?:\/\//);
});
