// What the pointer does in the office: hovering a desk, a person away from
// their desk, a printer or a build-mode slot (a ring and the tooltip), and
// clicking one, told apart from a drag that pans. Also the selection marker
// over the selected desk.

import { Container, Graphics } from "pixi.js";
import { hex } from "@kauak/appearance/registry";
import { STATUS_COLOR, type DeskNode } from "./character";
import * as P from "./props";
import type { Prints } from "../printers/prints";
import { deskFootprint, type BuildTarget, type Look, type Slot } from "./floor-renderer";
import type { PrinterNode } from "./printer-animator";
import type { Tooltip } from "./tooltip";
import type { PaneInfo } from "@kauak/protocol";

// A press that moves further than this (px) is a pan, not a click.
const DRAG_SLOP = 4;

/** What a pointer is on: a desk, a printer or a build-mode slot. */
type Hit = { key: string; pane: PaneInfo } | { key: string; printer: PrinterNode } | { key: string; slot: Slot };

export interface PickerHandlers {
  onSelectPane(pane: PaneInfo): void;
  onHoverPane(paneId: string | null): void;
  /** A click on the office itself, away from every desk. */
  onEmptyClick(): void;
  /** A click on a build-mode slot, at screen point (x, y). */
  onBuild(target: BuildTarget, x: number, y: number): void;
  /** A click on a room's printer. */
  onOpenPrinter(key: string, room: string, label: string): void;
}

export class Picker {
  private plumbob = new Container();
  private hoverRing = new Graphics();
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  /** What is on the floor drawn now (track()). */
  private nodes: DeskNode[] = [];
  private printers: PrinterNode[] = [];
  private slots: Slot[] = [];

  /** The hover ring and the selection marker go on `overlay`; `prints` is what the printers hold. */
  constructor(
    overlay: Container,
    private tooltip: Tooltip,
    private look: Look,
    private prints: () => Prints | null,
    private h: PickerHandlers,
  ) {
    overlay.addChild(this.hoverRing, this.plumbob);
    this.drawPlumbob();
  }

  /** Clicks on the office: on a desk, a printer, a build slot or nothing. The camera pans on the same presses (it listens first). */
  attach(stage: Container) {
    // `hit` is the key of the desk or slot under the press, if any; `moved` means it panned, so it is not a click.
    let pressed: { x: number; y: number; hit: string | null; moved: boolean } | null = null;
    stage.on("pointerdown", (e) => {
      pressed = { x: e.global.x, y: e.global.y, hit: this.hitOf(e.target)?.key ?? null, moved: false };
    });
    // Clicks are resolved here rather than with pointertap: every snapshot
    // rebuilds the desks, and Pixi drops a tap whose pressed desk was replaced
    // before the release. Matching by key (the pane id) survives the rebuild.
    stage.on("pointerup", (e) => {
      const press = pressed;
      pressed = null;
      if (!press || press.moved || e.button !== 0) return;
      const hit = this.hitOf(e.target);
      if (!hit) {
        if (press.hit === null) this.h.onEmptyClick();
        return;
      }
      if (hit.key !== press.hit) return;
      this.tooltip.hide(); // a panel or form is about to cover the pointer
      if ("pane" in hit) this.h.onSelectPane(hit.pane);
      else if ("printer" in hit) this.h.onOpenPrinter(hit.printer.key, hit.printer.room, hit.printer.label);
      else this.h.onBuild(hit.slot.target, e.global.x, e.global.y);
    });
    stage.on("pointerupoutside", () => (pressed = null));
    stage.on("pointermove", (e) => {
      if (!pressed) return;
      const dx = e.global.x - pressed.x,
        dy = e.global.y - pressed.y;
      if (Math.hypot(dx, dy) > DRAG_SLOP) pressed.moved = true;
    });
  }

  /**
   * After each draw: what is on the floor now, and what the pointer does over
   * its desks, their people, the printers and the build slots. The selection
   * marker moves to the new desk, and nothing is hovered until Pixi sends the
   * pointer over the new objects.
   */
  track(nodes: DeskNode[], printers: PrinterNode[], slots: Slot[]) {
    this.nodes = nodes;
    this.printers = printers;
    this.slots = slots;
    for (const node of nodes) {
      const pane = node.desk.pane;
      for (const target of [node.root, node.person]) {
        if (!target) continue;
        target.on("pointerover", (e) => {
          this.setHover(pane.pane_id);
          this.tooltip.pane(pane, node.state.roam, e.global.x, e.global.y);
        });
        target.on("pointermove", (e) => this.tooltip.pane(pane, node.state.roam, e.global.x, e.global.y));
        target.on("pointerout", () => {
          this.setHover(null);
          this.tooltip.hide();
        });
      }
    }
    for (const node of printers) {
      node.root.on("pointerover", (e) => {
        this.ringPrinter(node);
        this.tooltip.printer(this.prints(), node.key, e.global.x, e.global.y);
      });
      node.root.on("pointermove", (e) => this.tooltip.printer(this.prints(), node.key, e.global.x, e.global.y));
      node.root.on("pointerout", () => {
        this.hoverRing.clear();
        this.hoveredId = null;
        this.tooltip.hide();
      });
    }
    for (const slot of slots) {
      slot.root.on("pointerover", (e) => {
        slot.hover(true);
        this.tooltip.build(slot.tip, e.global.x, e.global.y);
      });
      slot.root.on("pointermove", (e) => this.tooltip.build(slot.tip, e.global.x, e.global.y));
      slot.root.on("pointerout", () => {
        slot.hover(false);
        this.tooltip.hide();
      });
    }
    this.updatePlumbob();
    this.setHover(null);
  }

  select(paneId: string | null) {
    this.selectedId = paneId;
    this.updatePlumbob();
  }

  private drawPlumbob() {
    const g = new Graphics();
    // Sims-style diamond: two halves so it reads as 3D when we squash scale.x
    g.poly([0, -22, 8, -8, 0, 8]).fill(0x7bff7b);
    g.poly([0, -22, -8, -8, 0, 8]).fill(0x38c95a);
    g.poly([0, -22, 8, -8, 0, -8]).stroke({ color: 0xd7ffd7, width: 1, alpha: 0.7 });
    this.plumbob.addChild(g);
    this.plumbob.visible = false;
  }

  private updatePlumbob() {
    const node = this.nodes.find((n) => n.desk.pane.pane_id === this.selectedId);
    this.plumbob.visible = !!node;
    if (node) this.plumbob.position.set(node.anchor.x, node.anchor.y - 22);
  }

  private setHover(id: string | null) {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    this.hoverRing.clear();
    const node = this.nodes.find((n) => n.desk.pane.pane_id === id);
    if (node) {
      const d = node.desk;
      const c = STATUS_COLOR[d.pane.agent_status];
      deskFootprint(this.hoverRing, d, 0.5).stroke({ color: c, width: 2, alpha: 0.9 });
      deskFootprint(this.hoverRing, d, 0.5).fill({ color: c, alpha: 0.08 });
    }
    this.h.onHoverPane(id);
  }

  private ringPrinter(n: PrinterNode) {
    this.hoveredId = null;
    this.hoverRing.clear();
    const accent = hex(this.look.theme.palette.accent);
    P.floorPoly(this.hoverRing, n.at.x - 0.08, n.at.y - 0.06, P.PRINTER.w + 0.16, P.PRINTER.d + 0.12, 0.5)
      .fill({ color: accent, alpha: 0.08 })
      .stroke({ color: accent, width: 2, alpha: 0.9 });
  }

  /** The desk or slot `target` is (they are the only objects that take clicks, with people away from their desks). */
  private hitOf(target: unknown): Hit | null {
    const node = this.nodes.find((n) => n.root === target || n.person === target);
    if (node) return { key: node.desk.pane.pane_id, pane: node.desk.pane };
    const printer = this.printers.find((p) => p.root === target);
    if (printer) return { key: `printer:${printer.room}`, printer };
    const slot = this.slots.find((sl) => sl.root === target);
    return slot ? { key: slot.key, slot } : null;
  }

  /** The selection marker spins and bobs over the selected desk, following a walking person. */
  tick(now: number) {
    if (this.plumbob.visible) {
      const t = now / 1000;
      this.plumbob.scale.x = 0.55 + Math.abs(Math.cos(t * 2.2)) * 0.45;
      this.plumbob.y += 0;
      const node = this.nodes.find((n) => n.desk.pane.pane_id === this.selectedId);
      if (node) this.plumbob.position.set(node.anchor.x, node.anchor.y - 22 + Math.sin(t * 3) * 3);
    }
  }
}
