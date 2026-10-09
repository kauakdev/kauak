// The page's preferences in localStorage: the floor on screen, the hidden
// feed, the build form's agent, the radio and the terminal panel's width.

export type Key = "kauak.floor" | "kauak.feed-hidden" | "kauak.build.agent" | "kauak.radio" | "kauak.panel-width";

// localStorage can be missing or throw (private windows, blocked site data).
export function load(key: Key): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: Key, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
