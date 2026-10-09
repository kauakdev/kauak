// The page's preferences in localStorage: the floor on screen, the hidden
// feed, the build form's agent, the radio and the terminal panel's width.
// They were saved under agent-office.* names before the rename; the first read
// of a key without a value copies its old value over, once, the way
// @kauak/appearance's loadPreferences copies the appearance settings. The old
// key is left as it was, for an older version, and is never written.

const RENAMED = [
  ["kauak.floor", "agent-office.floor"],
  ["kauak.feed-hidden", "agent-office.feed-hidden"],
  ["kauak.build.agent", "agent-office.build.agent"],
  ["kauak.radio", "agent-office.radio"],
  ["kauak.panel-width", "agent-office.panel-width"],
] as const;
// A Map, not an object literal, so no key can reach the prototype.
const OLD_NAME = new Map<string, string>(RENAMED);

export type Key = (typeof RENAMED)[number][0];

/**
 * The value saved under `key`, or null. Without one, it is the value saved
 * under the key's old name, copied to `key` when `accepts` says its reader would
 * use it: a value the reader turns down is not copied, and a copy that cannot be
 * written is tried again on the next read.
 */
export function load(key: Key, accepts: (value: string) => boolean = () => true): string | null {
  // localStorage can be missing or throw (private windows, blocked site data).
  try {
    const value = localStorage.getItem(key);
    if (value !== null) return value;
    const old = localStorage.getItem(OLD_NAME.get(key)!);
    if (old !== null && accepts(old)) save(key, old);
    return old;
  } catch {
    return null;
  }
}

export function save(key: Key, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
