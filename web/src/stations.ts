// Stations on the office radio's FM dial. A station is listed only when its
// operator explicitly allows third-party players, with conditions Kauak meets:
// CLIAMP's site invites playing its streams in "any player of your choice".
// The radio card credits each one with its name and a link to `site`.
//
// Streams run through Web Audio, so every hop of a stream URL, redirects
// included, must also send CORS headers and accept a foreign Referer
// (radio.cliamp.stream did on 2026-10-07).

export interface Station {
  freq: number;
  name: string;
  genre: string;
  url: string;
  site: string;
}

export const STATIONS: Station[] = [
  { freq: 95.5, name: "CLIAMP Lofi", genre: "lofi hip hop", url: "https://radio.cliamp.stream/lofi/stream", site: "https://cliamp.stream" },
];
