// The message box's "/" menu: while the box holds "/" and the start of a
// command name, the matching commands of the pane's agent show above it, as
// in the agent's own prompt. The panel owns the keys (↑ ↓ pick, Tab
// completes, Enter runs, Esc closes); this class filters and draws.

import type { SlashCommand } from "./types";

// "/", then a name so far: no space yet (arguments close the menu), no "/"
// further on (a path such as /tmp/x is not a command).
const TYPING_NAME = /^\/([\w.:-]*)$/;

export class SlashMenu {
  /** A row was clicked. */
  onPick: (cmd: SlashCommand) => void = () => {};

  private commands: SlashCommand[] = [];
  private shown: SlashCommand[] = [];
  private active = 0;
  private query: string | null = null;
  private dismissed: string | null = null; // the box text Esc closed the menu on

  constructor(private el: HTMLElement, private box: HTMLTextAreaElement) {
    this.box.setAttribute("aria-controls", el.id);
    this.box.setAttribute("aria-autocomplete", "list");
    // Rows must not take focus from the box.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
      if (this.shown[i]) this.onPick(this.shown[i]);
    });
    el.addEventListener("mousemove", (e) => {
      const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
      if (Number.isInteger(i) && i !== this.active) this.highlight(i);
    });
  }

  get open(): boolean { return this.shown.length > 0; }

  /** Whether the agent has commands at all (panes without one have none). */
  get any(): boolean { return this.commands.length > 0; }

  /** The agent's commands, from the bridge. */
  setCommands(cmds: SlashCommand[]) {
    this.commands = cmds;
    this.query = null;
    this.update(this.box.value);
  }

  /** A command by name, for the usage hint once it is typed out. */
  find(name: string): SlashCommand | undefined { return this.commands.find((c) => c.name === name); }

  /** The highlighted command, while the menu is open. */
  get current(): SlashCommand | undefined { return this.shown[this.active]; }

  /** Follow the box's text: open, filter, or close. */
  update(text: string) {
    const m = TYPING_NAME.exec(text);
    if (text !== this.dismissed) this.dismissed = null;
    const query = m && this.dismissed === null ? m[1]!.toLowerCase() : null;
    if (query === this.query && this.shown.length) return;
    this.query = query;
    this.shown = query === null ? [] : rank(this.commands, query);
    this.active = 0;
    this.render();
  }

  /** Esc: close until the text changes. */
  dismiss() {
    this.dismissed = this.box.value;
    this.close();
  }

  close() {
    this.query = null;
    this.shown = [];
    this.render();
  }

  move(delta: number) {
    if (!this.open) return;
    this.highlight((this.active + delta + this.shown.length) % this.shown.length);
  }

  private highlight(i: number) {
    this.el.children[this.active]?.setAttribute("aria-selected", "false");
    this.active = i;
    const row = this.el.children[i];
    row?.setAttribute("aria-selected", "true");
    row?.scrollIntoView({ block: "nearest" });
    this.box.setAttribute("aria-activedescendant", `slash-${i}`);
  }

  private render() {
    this.el.hidden = !this.open;
    this.box.setAttribute("aria-expanded", String(this.open));
    if (!this.open) { this.box.removeAttribute("aria-activedescendant"); this.el.replaceChildren(); return; }
    this.el.replaceChildren(...this.shown.map((c, i) => {
      const li = document.createElement("li");
      li.id = `slash-${i}`;
      li.dataset.i = String(i);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === this.active));
      const name = span("n", `/${c.name}`);
      if (c.aliases?.length) name.append(span("a", ` (${c.aliases.join(", ")})`));
      li.append(name, span("d", c.description));
      if (c.source !== "built-in") li.append(span("s", c.source));
      li.title = [`/${c.name}${c.hint ? ` ${c.hint}` : ""}`, c.description].filter(Boolean).join("\n");
      return li;
    }));
    this.el.scrollTop = 0;
    this.box.setAttribute("aria-activedescendant", "slash-0");
  }
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

/**
 * Commands matching `q`, best first: an exact name, then names that start
 * with it (a plugin command's own part, after the ":", counts, as do
 * aliases), then names with a word that starts with it, then names that
 * contain it. Names that only have its letters in order are the fallback
 * when nothing else matches (they would bury the real matches otherwise).
 */
export function rank(cmds: SlashCommand[], q: string): SlashCommand[] {
  const scored: [number, SlashCommand][] = [];
  for (const c of cmds) {
    const name = c.name.toLowerCase();
    const names = [name, name.slice(name.lastIndexOf(":") + 1), ...(c.aliases ?? [])];
    let score: number;
    if (!q) score = 0;
    else if (names.includes(q)) score = 0;
    else if (name.startsWith(q)) score = 1;
    else if (names.some((n) => n.startsWith(q))) score = 2;
    else if (name.split(/[-_:.]/).some((w) => w.startsWith(q))) score = 3;
    else if (name.includes(q)) score = 4;
    else if (subsequence(q, name)) score = 5;
    else continue;
    scored.push([score, c]);
  }
  const close = scored.some(([s]) => s < 5) ? scored.filter(([s]) => s < 5) : scored;
  return close.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).map(([, c]) => c);
}

function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}
