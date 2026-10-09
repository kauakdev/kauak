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

const RENAMED: [Key, string][] = [
  ["kauak.floor", "agent-office.floor"],
  ["kauak.feed-hidden", "agent-office.feed-hidden"],
  ["kauak.build.agent", "agent-office.build.agent"],
  ["kauak.radio", "agent-office.radio"],
  ["kauak.panel-width", "agent-office.panel-width"],
];
// Unusual bytes, so a copy that is not the same string shows.
const OLD = ' {"freq": 92.5, "on": true}\n · é ';

beforeEach(() => {
  stored.clear();
  calls.length = 0;
  failWrites = false;
  vi.stubGlobal("localStorage", storage);
});

test.each(RENAMED)("%s: an old value only is copied once and used, and the old key is left byte for byte", (key, old) => {
  stored.set(old, OLD);
  expect(load(key)).toBe(OLD);
  expect(stored.get(key)).toBe(OLD);
  expect(stored.get(old)).toBe(OLD);
  expect(calls).toStrictEqual([`get ${key}`, `get ${old}`, `set ${key}`]);
  calls.length = 0;
  expect(load(key)).toBe(OLD);
  expect(calls).toStrictEqual([`get ${key}`]);
});

test.each(RENAMED)("%s: a value under the new key wins, even an empty or a turned-down one, and the old key is not read", (key, old) => {
  stored.set(old, OLD);
  const accepts = vi.fn(() => false);
  for (const value of ["devbox", "", "{broken"]) {
    stored.set(key, value);
    calls.length = 0;
    expect(load(key, accepts)).toBe(value);
    expect(calls).toStrictEqual([`get ${key}`]);
  }
  expect(accepts).not.toHaveBeenCalled();
  expect(stored.get(old)).toBe(OLD);
});

test.each(RENAMED)("%s: with neither key there is nothing saved, and nothing is written", (key, old) => {
  expect(load(key)).toBe(null);
  expect(calls).toStrictEqual([`get ${key}`, `get ${old}`]);
});

test("an old value the reader turns down is not copied, and is read as before", () => {
  stored.set("agent-office.panel-width", "wide");
  const accepts = vi.fn((v: string) => Boolean(Number(v)));
  expect(load("kauak.panel-width", accepts)).toBe("wide");
  expect(load("kauak.panel-width", accepts)).toBe("wide");
  expect(accepts.mock.calls).toStrictEqual([["wide"], ["wide"]]);
  expect(calls.filter((c) => c.startsWith("set"))).toStrictEqual([]);
  expect([...stored]).toStrictEqual([["agent-office.panel-width", "wide"]]);
  stored.set("agent-office.panel-width", "640");
  expect(load("kauak.panel-width", accepts)).toBe("640");
  expect(stored.get("kauak.panel-width")).toBe("640");
});

test("a copy that cannot be written still gives the old value, and is tried again on the next read", () => {
  stored.set("agent-office.radio", OLD);
  failWrites = true;
  expect(load("kauak.radio")).toBe(OLD);
  expect(stored.has("kauak.radio")).toBe(false);
  failWrites = false;
  calls.length = 0;
  expect(load("kauak.radio")).toBe(OLD);
  expect(calls).toStrictEqual(["get kauak.radio", "get agent-office.radio", "set kauak.radio"]);
  expect(stored.get("kauak.radio")).toBe(OLD);
  expect(stored.get("agent-office.radio")).toBe(OLD);
});

test("saving writes only the new key, and a write that throws is dropped", () => {
  stored.set("agent-office.feed-hidden", "1");
  save("kauak.feed-hidden", "0");
  expect([...stored]).toStrictEqual([
    ["agent-office.feed-hidden", "1"],
    ["kauak.feed-hidden", "0"],
  ]);
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

  // The new key reads, the old one throws.
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k.startsWith("kauak.") ? null : blocked()), setItem: blocked });
  expect(load("kauak.floor")).toBe(null);
});
