import { beforeEach, expect, test, vi } from "vitest";
import { load, save, type Key } from "./storage";

// A Map stands in for the browser's localStorage, and records each read and write.
const stored = new Map<string, string>();
const calls: string[] = [];
let failWrites = false;
const storage = {
  getItem: (k: string) => {
    calls.push(`get ${k}`);
    return stored.get(k) ?? null;
  },
  setItem: (k: string, v: string) => {
    calls.push(`set ${k}`);
    if (failWrites) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    stored.set(k, String(v));
  },
};

const KEYS: Key[] = ["kauak.floor", "kauak.feed-hidden", "kauak.build.agent", "kauak.radio", "kauak.panel-width"];

beforeEach(() => {
  stored.clear();
  calls.length = 0;
  failWrites = false;
  vi.stubGlobal("localStorage", storage);
});

test.each(KEYS)("%s: the value saved under the key is read as it was, even an empty or a broken one", (key) => {
  for (const value of ["devbox", "", "{broken"]) {
    stored.set(key, value);
    calls.length = 0;
    expect(load(key)).toBe(value);
    expect(calls).toStrictEqual([`get ${key}`]);
  }
});

test.each(KEYS)("%s: with nothing saved there is nothing, and nothing is written", (key) => {
  expect(load(key)).toBe(null);
  expect(calls).toStrictEqual([`get ${key}`]);
});

test("saving writes the key, and a write that throws is dropped", () => {
  save("kauak.feed-hidden", "0");
  expect([...stored]).toStrictEqual([["kauak.feed-hidden", "0"]]);
  failWrites = true;
  expect(() => save("kauak.feed-hidden", "1")).not.toThrow();
  expect(stored.get("kauak.feed-hidden")).toBe("0");
});

test("without localStorage, or when reading it throws, nothing is saved and nothing throws", () => {
  vi.stubGlobal("localStorage", undefined);
  expect(load("kauak.floor")).toBe(null);
  expect(() => save("kauak.floor", "devbox")).not.toThrow();

  const blocked = () => {
    throw new DOMException("Access is denied for this document.", "SecurityError");
  };
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });
  expect(load("kauak.floor")).toBe(null);
  expect(() => save("kauak.floor", "devbox")).not.toThrow();
});
