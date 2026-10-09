// A printer's sheets, read up close. Clicking a printer picks its newest sheet
// up off the tray: the page rises from where it lies in the office, turning
// from the floor's angle to face you as it grows, over the dimmed office.
// Esc, a click beside the page or Close puts it back down on the tray.
//
// Two things to read, tabs under the page (U switches):
// - Edits: the sheets as they were printed, one edit each; ←/→ leaf through them.
// - Uncommitted: everything not committed in the checkout right now, asked of
//   the bridge when the tab opens (and again when another sheet lands), as one
//   long printout with a page per file; ←/→ go from file to file.
//
// The page starts as the sheet on the tray: the office's 2:1 projection of a
// flat sheet is rotateZ(45°) then rotateX(60°) (cos 60° halves its height),
// and every keyframe uses that same list of transforms, so the browser turns
// each angle smoothly rather than blending two matrices.

import type { Prints } from "./prints";
import { escapeHtml } from "../app/html";
import type { DiffSheet, FileDiff, Uncommitted } from "@kauak/protocol";
import "./printout.css";

/** Where a printer's top sheet is on screen, and the office's zoom. */
export interface Tray {
  x: number;
  y: number;
  scale: number;
}

type Mode = "edits" | "uncommitted";

const LIFT_MS = 720;
const DROP_MS = 460;
const LEAF_MS = 150;
// A tile along a flat sheet's edge, at zoom 1: the tile's half-width (32 px on screen) over cos 45°.
const TILE_EDGE = 32 / Math.SQRT1_2;
// How wide the sheet on the tray is, in tiles (props.ts PRINTER.sheet.w).
const TRAY_SHEET = 0.3;
const PERSPECTIVE = "perspective(1800px)";
// Sheets that land while the page is up join the count (and refresh the uncommitted view).
const SYNC_MS = 500;

interface Pose {
  x: number;
  y: number;
  tilt: number;
  turn: number;
  scale: number;
}

export class Printout {
  private el: HTMLElement;
  private backdrop: HTMLElement;
  private sheet: HTMLElement;
  private nav: HTMLElement;
  private count: HTMLElement;
  private prevBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private tabs: HTMLButtonElement[];
  private key: string | null = null;
  private label = "";
  private mode: Mode = "edits";
  /** Edits: the sheet shown. */
  private index = 0;
  /** Uncommitted: the file in view, and until when a jump to one is still scrolling there. */
  private file = 0;
  private jumping = 0;
  /** Uncommitted: the latest answer (null while the first is on its way) and when it came. */
  private work: (Uncommitted & { at: number }) | null = null;
  private asked = 0;
  /** Sheets printed when the uncommitted view was last asked for. */
  private askedAt = -1;
  private tray: () => Tray | null = () => null;
  private busy = false;
  private closing = false;
  private returnFocus: Element | null = null;
  private sync = 0;
  /** Ask the bridge for a printer's uncommitted view (answered with `receive`); false when it cannot be asked. */
  request: (key: string, id: number) => boolean = () => false;

  constructor(private prints: Prints) {
    this.el = document.createElement("div");
    this.el.id = "printout";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="po-backdrop"></div>
      <article class="po-sheet" role="dialog" aria-modal="true" aria-labelledby="po-path" tabindex="-1"></article>
      <nav class="po-nav card">
        <div class="po-tabs" role="tablist" aria-label="What to read">
          <button role="tab" data-mode="edits" title="Each edit, as it was printed (U)">Edits <span class="n"></span></button>
          <button role="tab" data-mode="uncommitted" title="Everything not committed yet (U)">Uncommitted</button>
        </div>
        <button class="btn" data-go="prev"></button>
        <span class="po-count"></span>
        <button class="btn" data-go="next"></button>
        <button class="btn" data-go="close">Close<kbd>Esc</kbd></button>
      </nav>`;
    document.body.appendChild(this.el);
    this.backdrop = this.el.querySelector(".po-backdrop")!;
    this.sheet = this.el.querySelector(".po-sheet")!;
    this.nav = this.el.querySelector(".po-nav")!;
    this.count = this.el.querySelector(".po-count")!;
    this.prevBtn = this.el.querySelector('[data-go="prev"]')!;
    this.nextBtn = this.el.querySelector('[data-go="next"]')!;
    this.tabs = [...this.el.querySelectorAll<HTMLButtonElement>("[data-mode]")];
    this.backdrop.addEventListener("click", () => this.close());
    this.nav.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (b?.dataset.mode) this.setMode(b.dataset.mode as Mode);
      else if (b?.dataset.go === "prev") this.step(-1);
      else if (b?.dataset.go === "next") this.step(1);
      else if (b?.dataset.go === "close") this.close();
    });
    // The uncommitted printout's file list jumps to a file; scrolling says which file is in view.
    this.sheet.addEventListener("click", (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-jump]");
      if (a) {
        e.preventDefault();
        this.goToFile(Number(a.dataset.jump));
      }
    });
    this.sheet.addEventListener("scroll", () => this.fileInView(), true);
    // Capture: while the page is up, these keys are its own, and nothing else sees them.
    addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "Escape") this.close();
        else if (e.key === "ArrowLeft") this.step(-1);
        else if (e.key === "ArrowRight") this.step(1);
        else if (e.key === "u" || e.key === "U") this.setMode(this.mode === "edits" ? "uncommitted" : "edits");
        else return;
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    addEventListener("resize", () => {
      if (this.isOpen() && !this.busy) this.place(this.rest());
    });
  }

  isOpen(): boolean {
    return this.key !== null;
  }

  /**
   * Pick up printer `key`'s newest sheet, or with nothing printed yet its
   * uncommitted view. `tray` says where the printer's tray is now (null: not on screen).
   */
  open(key: string, label: string, tray: () => Tray | null) {
    if (this.isOpen()) return;
    this.key = key;
    this.label = label;
    this.tray = tray;
    this.index = Math.max(0, this.sheets().length - 1);
    this.work = null;
    this.mode = this.sheets().length ? "edits" : "uncommitted";
    if (this.mode === "uncommitted") this.ask();
    this.returnFocus = document.activeElement;
    this.el.hidden = false;
    this.el.classList.remove("closing");
    document.body.classList.add("printout-open");
    this.render();
    this.sync = window.setInterval(() => this.syncNav(), SYNC_MS);
    this.sheet.focus({ preventScroll: true });
    const from = this.trayPose();
    const to = this.rest();
    this.busy = true;
    this.animate(this.backdrop, [{ opacity: 0 }, { opacity: 1 }], LIFT_MS * 0.7, "ease-out");
    this.animate(
      this.nav,
      [
        { opacity: 0, transform: "translate(-50%, 12px)" },
        { opacity: 0, offset: 0.55 },
        { opacity: 1, transform: "translate(-50%, 0)" },
      ],
      LIFT_MS,
      "ease-out",
    );
    this.animate(
      this.sheet,
      [
        { transform: this.transform(from), boxShadow: "0 1px 2px #0000", opacity: 1 },
        { transform: this.transform(this.lifted(from, to)), boxShadow: "0 40px 70px #0007", opacity: 1, offset: 0.42 },
        { transform: this.transform(to), boxShadow: "0 30px 80px #000a", opacity: 1 },
      ],
      LIFT_MS,
      "cubic-bezier(.25,.75,.25,1)",
    ).then(() => {
      if (!this.closing) this.busy = false;
    });
  }

  /** Put the page back on the tray. */
  close() {
    if (!this.isOpen() || this.closing) return;
    this.closing = true;
    clearInterval(this.sync);
    this.el.classList.add("closing");
    const at = this.freeze(this.sheet);
    const to = this.trayPose();
    const offscreen = !this.tray();
    this.busy = true;
    this.animate(this.backdrop, [{ opacity: 1 }, { opacity: 0 }], DROP_MS, "ease-in");
    this.animate(this.nav, [{ opacity: 1 }, { opacity: 0 }], DROP_MS * 0.4, "ease-in");
    this.animate(
      this.sheet,
      [
        { transform: at, opacity: 1 },
        { transform: this.transform(this.lifted(to, this.rest())), opacity: 1, offset: 0.45 },
        { transform: this.transform(to), opacity: offscreen ? 0 : 1 },
      ],
      DROP_MS,
      "cubic-bezier(.5,0,.75,.4)",
    ).then(() => {
      this.el.hidden = true;
      document.body.classList.remove("printout-open");
      this.key = null;
      this.busy = this.closing = false;
      if (this.returnFocus instanceof HTMLElement) this.returnFocus.focus({ preventScroll: true });
    });
  }

  /** The bridge's answer to `request`; only the latest request for the open printer counts. */
  receive(key: string, id: number | undefined, result: Uncommitted) {
    if (key !== this.key || id !== this.asked || this.closing) return;
    this.work = { ...result, at: Date.now() };
    if (this.mode !== "uncommitted") return;
    // A refresh keeps the reader's place.
    const body = this.sheet.querySelector(".po-body");
    const top = body?.scrollTop ?? 0;
    this.render();
    const next = this.sheet.querySelector(".po-body");
    if (next) next.scrollTop = top;
    this.fileInView();
  }

  // ------------------------------------------------------------ content

  private sheets(): DiffSheet[] {
    return this.key ? this.prints.printed(this.key) : [];
  }

  private ask() {
    if (!this.key) return;
    this.askedAt = this.sheets().length;
    if (!this.request(this.key, ++this.asked))
      this.work = { files: [], incomplete: false, error: "The bridge is not connected.", at: Date.now() };
  }

  /** Switch tabs: the page slides aside and comes back with the other one. */
  private setMode(mode: Mode) {
    if (mode === this.mode || this.busy || this.closing) return;
    if (mode === "uncommitted") this.ask();
    this.swap(mode === "uncommitted" ? 1 : -1, () => {
      this.mode = mode;
    });
  }

  /** ←/→: the previous or next sheet, or file. */
  private step(dir: -1 | 1) {
    if (this.mode === "uncommitted") {
      this.goToFile(this.file + dir);
      return;
    }
    const next = this.index + dir;
    if (next < 0 || next >= this.sheets().length) return;
    this.swap(dir, () => {
      this.index = next;
    });
  }

  /** Slide the page aside (away from `dir`), change what it shows, slide it back. */
  private async swap(dir: -1 | 1, change: () => void) {
    if (this.busy || this.closing) return;
    this.busy = true;
    const rest = this.rest();
    const aside = (sign: number): Pose => ({ ...rest, x: rest.x + sign * 70, turn: rest.turn + sign * 5, scale: 0.97 });
    await this.animate(
      this.sheet,
      [
        { transform: this.transform(rest), opacity: 1 },
        { transform: this.transform(aside(-dir)), opacity: 0 },
      ],
      LEAF_MS,
      "ease-in",
    );
    if (this.closing) return;
    change();
    this.render();
    const after = this.rest();
    await this.animate(
      this.sheet,
      [
        { transform: this.transform({ ...aside(dir), y: after.y }), opacity: 0 },
        { transform: this.transform(after), opacity: 1 },
      ],
      LEAF_MS * 1.3,
      "ease-out",
    );
    if (!this.closing) this.busy = false;
  }

  private goToFile(i: number) {
    const body = this.sheet.querySelector<HTMLElement>(".po-body");
    const target = body?.querySelector<HTMLElement>(`.po-file[data-file="${i}"]`);
    if (!body || !target) return;
    this.file = i;
    this.jumping = performance.now() + 700;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    body.scrollTo({ top: target.offsetTop - body.offsetTop - 4, behavior: reduce ? "auto" : "smooth" });
    this.syncNav();
  }

  /** The file whose page is at the top of the printout. */
  private fileInView() {
    if (this.mode !== "uncommitted" || performance.now() < this.jumping) return;
    const body = this.sheet.querySelector<HTMLElement>(".po-body");
    if (!body) return;
    let i = 0;
    for (const f of body.querySelectorAll<HTMLElement>(".po-file")) {
      if (f.offsetTop - body.offsetTop <= body.scrollTop + 24) i = Number(f.dataset.file);
    }
    if (i !== this.file) {
      this.file = i;
      this.syncNav();
    }
  }

  private syncNav() {
    const n = this.sheets().length;
    const edits = this.mode === "edits";
    for (const t of this.tabs) {
      const on = t.dataset.mode === this.mode;
      t.setAttribute("aria-selected", String(on));
      t.classList.toggle("on", on);
    }
    this.tabs[0]!.querySelector(".n")!.textContent = n ? String(n) : "";
    const files = this.work?.files.length ?? 0;
    this.prevBtn.textContent = edits ? "‹ Older" : "‹ File";
    this.nextBtn.textContent = edits ? "Newer ›" : "File ›";
    this.prevBtn.title = edits ? "Older sheet (←)" : "Previous file (←)";
    this.nextBtn.title = edits ? "Newer sheet (→)" : "Next file (→)";
    this.prevBtn.disabled = edits ? this.index <= 0 : this.file <= 0;
    this.nextBtn.disabled = edits ? this.index >= n - 1 : this.file >= files - 1;
    this.count.textContent = edits ? (n ? `${this.index + 1} / ${n}` : "0 / 0") : files ? `${this.file + 1} / ${files}` : "—";
    // A sheet that lands while the uncommitted view is up means it changed.
    if (!edits && this.isOpen() && !this.closing && n !== this.askedAt) this.ask();
  }

  private render() {
    this.sheet.classList.toggle("long", this.mode === "uncommitted");
    if (this.mode === "uncommitted") this.renderUncommitted();
    else this.renderSheet();
    this.syncNav();
  }

  private renderSheet() {
    const list = this.sheets();
    const s = list[this.index];
    if (!s) {
      this.sheet.innerHTML = `
        <header class="po-head"><div class="po-meta"><span>kauak print service</span><span>${escapeHtml(this.label)}</span></div>
        <h2 id="po-path" class="po-path">Nothing printed yet</h2></header>
        <div class="po-body po-empty">Each time a file in this room's checkout changes, the printer prints a sheet with what changed.
          Everything not committed yet is under Uncommitted.</div>
        <footer class="po-foot">· · ·</footer>`;
      return;
    }
    this.prints.markRead(s.id);
    const time = new Date(s.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    this.sheet.innerHTML = `
      <header class="po-head">
        <div class="po-meta"><span>kauak print service · ${escapeHtml(this.label)}</span><span>#${String(this.index + 1).padStart(3, "0")} · ${time}</span></div>
        <h2 id="po-path" class="po-path">${pathHtml(s.path)}</h2>
        <div class="po-sub">${tag(s)}${counts(s.added, s.removed)}<span class="ago">${ago(s.at)}</span></div>
      </header>
      <div class="po-body">${fileBody(s)}</div>
      <footer class="po-foot">— sheet ${this.index + 1} of ${list.length} —</footer>`;
    this.sheet.querySelector(".po-body")!.scrollTop = 0;
  }

  private renderUncommitted() {
    const w = this.work;
    const head = (sub: string) => `
      <header class="po-head">
        <div class="po-meta"><span>kauak print service · ${escapeHtml(this.label)}</span><span>uncommitted${w ? ` · ${clock(w.at)}` : ""}</span></div>
        <h2 id="po-path" class="po-path">Uncommitted changes</h2>
        ${sub}
      </header>`;
    if (!w) {
      this.sheet.innerHTML = `${head("")}<div class="po-body po-empty po-printing">Printing the working tree<span class="dots"></span></div><footer class="po-foot">· · ·</footer>`;
      return;
    }
    if (w.error || !w.files.length) {
      const text = w.error
        ? `Could not read the checkout: ${escapeHtml(w.error)}`
        : "Nothing uncommitted: the working tree matches the last commit.";
      this.sheet.innerHTML = `${head("")}<div class="po-body po-empty">${text}</div><footer class="po-foot">· · ·</footer>`;
      return;
    }
    this.file = Math.min(this.file, w.files.length - 1);
    const added = w.files.reduce((n, f) => n + f.added, 0),
      removed = w.files.reduce((n, f) => n + f.removed, 0);
    const sub = `<div class="po-sub"><span class="files">${w.files.length} file${w.files.length === 1 ? "" : "s"}</span>${counts(added, removed)}<span class="ago">against the last commit</span></div>`;
    const index = w.files
      .map(
        (f, i) =>
          `<li><a href="#" data-jump="${i}">${tag(f, true)}<span class="p">${escapeHtml(f.path)}</span>${counts(f.added, f.removed)}</a></li>`,
      )
      .join("");
    const pages = w.files
      .map(
        (f, i) => `
      <section class="po-file" data-file="${i}">
        <h3 class="po-file-h">${tag(f)}<span class="p">${pathHtml(f.path)}</span>${counts(f.added, f.removed)}</h3>
        ${f.from ? `<div class="po-from">from ${escapeHtml(f.from)}</div>` : ""}
        ${fileBody(f)}
      </section>`,
      )
      .join("");
    const end = w.incomplete ? "… there was more than fits in one printout" : "— end of printout —";
    this.sheet.innerHTML = `${head(sub)}<div class="po-body"><ol class="po-index">${index}</ol>${pages}<div class="po-more">${end}</div></div>
      <footer class="po-foot">— uncommitted · ${w.files.length} file${w.files.length === 1 ? "" : "s"} —</footer>`;
  }

  // ------------------------------------------------------------ motion

  /** Resting in front of you, a little askew, centered above the buttons. */
  private rest(): Pose {
    const w = this.sheet.offsetWidth,
      h = this.sheet.offsetHeight;
    const below = this.nav.offsetHeight + 36;
    return { x: innerWidth / 2 - w / 2, y: Math.max(12, (innerHeight - below - h) / 2), tilt: 0, turn: -1.2, scale: 1 };
  }

  /** Lying on the tray, the office's size; or, with the printer off screen, falling out of view. */
  private trayPose(): Pose {
    const w = this.sheet.offsetWidth,
      h = this.sheet.offsetHeight;
    const t = this.tray();
    if (!t) return { x: innerWidth / 2 - w / 2, y: innerHeight + h * 0.2, tilt: 50, turn: 20, scale: 0.3 };
    const scale = Math.max(0.01, (TRAY_SHEET * TILE_EDGE * t.scale) / w);
    return { x: t.x - w / 2, y: t.y - h / 2, tilt: 60, turn: 45, scale };
  }

  /** Halfway up: off the tray and turning toward you, held above the line between the two. */
  private lifted(low: Pose, high: Pose): Pose {
    const k = 0.4;
    return {
      x: low.x + (high.x - low.x) * k,
      y: low.y + (high.y - low.y) * k - Math.min(120, innerHeight * 0.12),
      tilt: 32,
      turn: 16,
      scale: low.scale + (high.scale - low.scale) * 0.35,
    };
  }

  private transform(p: Pose): string {
    return `translate(${p.x}px, ${p.y}px) ${PERSPECTIVE} rotateX(${p.tilt}deg) rotateZ(${p.turn}deg) scale(${p.scale})`;
  }

  private place(p: Pose) {
    this.sheet.style.transform = this.transform(p);
  }

  /** Stop the element where it is now, mid-flight or not, and return that transform. */
  private freeze(el: HTMLElement): string {
    const now = getComputedStyle(el).transform;
    for (const a of el.getAnimations()) a.cancel();
    el.style.transform = now === "none" ? "" : now;
    return el.style.transform;
  }

  /** Run keyframes to the end, then keep the last one as the element's own style. */
  private animate(el: HTMLElement, frames: Keyframe[], ms: number, easing: string): Promise<void> {
    const { offset: _o, easing: _e, composite: _c, ...last } = frames[frames.length - 1]!;
    const keep = () => {
      for (const [k, v] of Object.entries(last)) el.style.setProperty(kebab(k), String(v));
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      keep();
      return Promise.resolve();
    }
    for (const a of el.getAnimations()) a.cancel();
    const a = el.animate(frames, { duration: ms, easing, fill: "forwards" });
    return a.finished.then(
      () => {
        keep();
        a.cancel();
      },
      () => {},
    );
  }
}

/** A file's rows, or why there are none. */
function fileBody(f: FileDiff): string {
  const more = f.truncated ? `<div class="po-more">… the rest did not fit on the sheet</div>` : "";
  return f.note ? `<div class="po-note">${escapeHtml(f.note)}</div>` : rows(f.diff) + more;
}

/** Unified hunks as numbered rows. */
function rows(diff: string): string {
  let o = 0,
    n = 0;
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      o = Number(h[1]);
      n = Number(h[2]);
      out.push(`<div class="r hunk"><span></span><span></span><span></span><code>${escapeHtml(line)}</code></div>`);
      continue;
    }
    const k = line[0],
      text = escapeHtml(line.slice(1));
    if (k === "+") out.push(`<div class="r add"><span></span><span>${n++}</span><span>+</span><code>${text}</code></div>`);
    else if (k === "-") out.push(`<div class="r del"><span>${o++}</span><span></span><span>−</span><code>${text}</code></div>`);
    else out.push(`<div class="r"><span>${o++}</span><span>${n++}</span><span></span><code>${text}</code></div>`);
  }
  return out.join("");
}

function tag(f: FileDiff, short = false): string {
  const word = f.untracked ? "untracked" : f.change;
  // Short, as `git status --short` writes them.
  const letter = f.untracked ? "?" : word[0]!.toUpperCase();
  return `<span class="chg chg-${f.untracked ? "added" : f.change}" title="${word}">${short ? letter : word}</span>`;
}

function counts(added: number, removed: number): string {
  return `<span class="add${added ? "" : " none"}">+${added}</span><span class="del${removed ? "" : " none"}">−${removed}</span>`;
}

function pathHtml(p: string): string {
  const slash = p.lastIndexOf("/");
  return `<span class="dir">${escapeHtml(p.slice(0, slash + 1))}</span>${escapeHtml(p.slice(slash + 1))}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

function kebab(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
