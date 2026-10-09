// The rooms' printers on the floor drawn now. Each prints the sheets its
// checkout queues (prints.ts) one at a time onto its tray, hums and blinks
// while it prints, and shows how many sheets are new. The printout flies up
// from where its top sheet is on screen (printout.ts).

import { Container, Graphics, Polygon, Text, TextStyle, type Application } from "pixi.js";
import { hex } from "@kauak/appearance/registry";
import { depth, shade, toScreen } from "./iso";
import type { Room, Spot } from "./layout";
import * as P from "./props";
import type { Prints } from "../printers/prints";
import type { Tray } from "../printers/printout";
import type { Block } from "./roam";
import type { Look, Motion } from "./floor-renderer";

const printBadgeStyle = new TextStyle({
  fill: 0x1a1a1a,
  fontSize: 11,
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontWeight: "800",
});
// One sheet through the printer; sheets that pile up past the last few (a floor
// nobody was looking at, a big refactor) go straight onto the tray.
const PRINT_MS = 1700;
const PRINT_BACKLOG = 3;
// How far above its footprint the printer stays clickable (px): up to its badge.
const PRINTER_HIT_H = 52;
const PRINTER_LIGHT = { idle: 0x3fbf6a, printing: 0x8dffa8, unread: 0xffd166 };

/** A room's printer. Rooms in one checkout share its sheets (`key`), each with a printer of its own. */
export interface PrinterNode {
  key: string;
  room: string;
  label: string;
  /** Back corner, world tiles. */
  at: Spot;
  root: Container;
  /** Hums while it prints. */
  body: Container;
  stack: Graphics;
  sheet: Graphics;
  light: Graphics;
  badge: Container;
  badgeBg: Graphics;
  badgeText: Text;
  badgeY: number;
  /** What is drawn now, to redraw only on a change. */
  shown: number;
  unread: number;
  lit: string;
}

export class PrinterAnimator {
  /** The printers on the floor drawn now. */
  nodes: PrinterNode[] = [];
  /** printer key → when its current sheet started printing; kept across rebuilds. */
  private printJobs = new Map<string, number>();

  /** `prints` is what the printers print, once the page has set it. */
  constructor(
    private app: Application,
    private world: Container,
    private objects: Container,
    private look: Look,
    private motion: Motion,
    private prints: () => Prints | null,
  ) {}

  /** Forgets the printers drawn; clearing the objects layer destroyed them. */
  clear() {
    this.nodes = [];
  }

  /** The room's printer, under the windows near the back corner, clear of the bench and the corner cabinet. */
  add(room: Room, key: string, blocks: Block[]) {
    const x = room.x + room.w - 1.55,
      y = room.y + 0.2;
    const root = new Container(),
      body = new Container();
    const base = new Graphics();
    P.printer(base, x, y, this.look.materials);
    const stack = new Graphics(),
      sheet = new Graphics(),
      light = new Graphics();
    body.addChild(base, stack, sheet, light);
    const badge = new Container(),
      badgeBg = new Graphics(),
      badgeText = new Text({ text: "", style: printBadgeStyle });
    badgeText.anchor.set(0, 0.5);
    badge.addChild(badgeBg, badgeText);
    const top = toScreen(x + P.PRINTER.w / 2, y + 0.3, 44);
    badge.position.set(top.x, top.y);
    badge.visible = false;
    root.addChild(body, badge);
    root.zIndex = depth(x, y) * 10;
    root.eventMode = "static";
    root.interactiveChildren = false;
    root.cursor = "pointer";
    root.hitArea = printerHitArea(x, y);
    const label = room.workspace.label || room.workspace.workspace_id;
    const node: PrinterNode = {
      key,
      room: room.workspace.workspace_id,
      label,
      at: { x, y },
      root,
      body,
      stack,
      sheet,
      light,
      badge,
      badgeBg,
      badgeText,
      badgeY: top.y,
      shown: -1,
      unread: -1,
      lit: "",
    };
    this.objects.addChild(root);
    this.nodes.push(node);
    blocks.push({ x: x - room.x, y: y - room.y, w: P.PRINTER.w, d: P.PRINTER.d });
    this.paint(node, this.motion.reduced ? 0 : performance.now());
  }

  /** Where a printer's top sheet is on screen (CSS px) and the zoom; null when that room's printer is not drawn. */
  tray(key: string, room: string): Tray | null {
    const n = this.nodes.find((p) => p.key === key && p.room === room) ?? this.nodes.find((p) => p.key === key);
    if (!n) return null;
    const s = P.PRINTER.sheet;
    const at = this.world.toGlobal(toScreen(n.at.x + s.x + s.w / 2, n.at.y + s.y + s.d / 2, P.paperTop(n.shown)));
    const box = this.app.canvas.getBoundingClientRect();
    return { x: box.left + at.x, y: box.top + at.y, scale: this.world.scale.x };
  }

  /** Start the next sheet of each printer, and finish the one that is out. */
  tick(now: number) {
    const prints = this.prints();
    if (!prints) return;
    const seen = new Set<string>();
    for (const n of this.nodes) {
      if (seen.has(n.key)) continue;
      seen.add(n.key);
      if (this.motion.reduced) {
        this.printJobs.delete(n.key);
        prints.done(n.key, true);
        continue;
      }
      const started = this.printJobs.get(n.key);
      if (started !== undefined && now - started >= PRINT_MS) {
        prints.done(n.key);
        this.printJobs.delete(n.key);
      }
      if (!this.printJobs.has(n.key) && prints.queuedCount(n.key) > 0) {
        while (prints.queuedCount(n.key) > PRINT_BACKLOG) prints.done(n.key);
        this.printJobs.set(n.key, now);
      }
    }
    for (const n of this.nodes) this.paint(n, now);
  }

  private paint(n: PrinterNode, now: number) {
    const prints = this.prints();
    const count = prints?.printedCount(n.key) ?? 0;
    if (count !== n.shown) {
      n.shown = count;
      n.stack.clear();
      P.paperStack(n.stack, n.at.x, n.at.y, count);
    }
    const started = this.printJobs.get(n.key);
    n.sheet.clear();
    n.body.x = 0;
    if (started !== undefined) {
      const t = Math.min(1, (now - started) / PRINT_MS);
      const out = Math.min(1, t / 0.75),
        fall = t <= 0.75 ? 0 : ((t - 0.75) / 0.25) ** 2;
      P.printingSheet(n.sheet, n.at.x, n.at.y, out, fall, P.paperTop(count + 1));
      if (t < 0.75) n.body.x = Math.sin(now / 18) * 0.5;
    }
    const unread = prints?.unread(n.key) ?? 0;
    const lit =
      started !== undefined
        ? Math.floor(now / 160) % 2
          ? "printing"
          : "idle"
        : unread > 0
          ? this.motion.reduced || Math.floor(now / 700) % 2
            ? "unread"
            : "dim"
          : "idle";
    if (lit !== n.lit) {
      n.lit = lit;
      n.light.clear();
      if (lit === "dim") P.printerLight(n.light, n.at.x, n.at.y, shade(PRINTER_LIGHT.unread, 0.55), false);
      else P.printerLight(n.light, n.at.x, n.at.y, PRINTER_LIGHT[lit as keyof typeof PRINTER_LIGHT], lit !== "idle");
    }
    if (unread !== n.unread) {
      n.unread = unread;
      n.badge.visible = unread > 0;
      n.badgeText.text = String(unread);
      const accent = hex(this.look.theme.palette.accent);
      const w = 25 + n.badgeText.width;
      n.badgeBg.clear();
      n.badgeBg
        .roundRect(-w / 2, -10, w, 20, 6)
        .fill(accent)
        .stroke({ color: shade(accent, 0.6), width: 1.5 });
      n.badgeBg.poly([-4, 9, 4, 9, -1, 15]).fill(accent);
      // a little sheet with rows on it
      n.badgeBg
        .rect(-w / 2 + 6, -6.5, 9, 12)
        .fill(0xfbfaf5)
        .stroke({ color: shade(accent, 0.5), width: 1 });
      for (const [ry, rw] of [
        [-3.5, 5],
        [-1, 3.5],
        [1.5, 5],
      ] as const)
        n.badgeBg.rect(-w / 2 + 8, ry, rw, 1).fill(0x6a6f80);
      n.badgeText.position.set(-w / 2 + 18, 0.5);
    }
    if (n.badge.visible) n.badge.y = n.badgeY - Math.abs(Math.sin(now / 320)) * 4;
  }
}

/** The printer's footprint plus the column above it, like a desk's. */
function printerHitArea(x: number, y: number): Polygon {
  const x0 = x - 0.05,
    y0 = y - 0.05,
    x1 = x + P.PRINTER.w + 0.05,
    y1 = y + P.PRINTER.d + 0.05,
    H = PRINTER_HIT_H;
  const top = toScreen(x0, y0),
    right = toScreen(x1, y0),
    bottom = toScreen(x1, y1),
    left = toScreen(x0, y1);
  return new Polygon([top.x, top.y - H, right.x, right.y - H, right.x, right.y, bottom.x, bottom.y, left.x, left.y, left.x, left.y - H]);
}
