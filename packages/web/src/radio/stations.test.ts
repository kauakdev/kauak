import { expect, test } from "vitest";
import { STATIONS } from "./stations";
// The radio's source as text: Vite's ?raw, as the page's types have no node:fs.
import radioSource from "./radio.ts?raw";

// Stations whose operators explicitly allow third-party players, with conditions
// Kauak meets. A station joins the dial only after it's added here too.
const ALLOWED = [{ name: "CLIAMP Lofi", url: "https://radio.cliamp.stream/lofi/stream", site: "https://cliamp.stream" }];

test("the dial carries exactly the allowed stations, each with its credit link", () => {
  expect(STATIONS.map(({ name, url, site }) => ({ name, url, site }))).toStrictEqual(ALLOWED);
});
test("each station streams over https from its credited site's domain, at its own spot on the band", () => {
  for (const s of STATIONS) {
    const stream = new URL(s.url),
      site = new URL(s.site);
    expect(stream.protocol).toBe("https:");
    expect(site.protocol).toBe("https:");
    expect(
      stream.host === site.host || stream.host.endsWith(`.${site.host}`),
      `${s.name} streams from ${stream.host}, not ${site.host}`,
    ).toBe(true);
    expect(s.freq >= 87.5 && s.freq <= 108, `${s.name} is off the band`).toBe(true);
  }
  expect(new Set(STATIONS.map((s) => s.freq)).size).toBe(STATIONS.length);
});
test("the radio plays only what stations.ts lists", () => {
  expect(radioSource).not.toMatch(/https?:\/\//);
});
