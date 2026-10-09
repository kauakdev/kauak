// PixiJS isometric rendering of the office, and the page's one entry to it.
// This file assembles the layers and runs each part in turn on every snapshot
// and every frame: floor-renderer.ts draws a floor, printer-animator.ts runs the
// rooms' printers, picker.ts answers the pointer and marks the selected desk,
// camera.ts moves the view and tooltip.ts owns the tooltip.
//
// Layers (back → front): ground (campus slab, corridors) → platforms (room
// slabs + shadows) → floor (tiles, rugs, walls, décor) → objects (depth-sorted
// desks, people, props) → overlay (selection marker, hover ring) → labels → motes.
//
// A room in a git checkout has a printer, which prints a sheet for every file
// edit there (prints.ts); clicking it opens the sheets (printout.ts).

import { Application, Container } from "pixi.js";
import type { BrandBanner, Characters, Theme } from "@kauak/appearance/contracts";
import { hex } from "@kauak/appearance/registry";
import { defaultCharacters, defaultTheme } from "../appearance/catalog";
import { buildOffice, type Office } from "./layout";
import * as P from "./props";
import type { Prints } from "../printers/prints";
import type { Tray } from "../printers/printout";
import { Tooltip } from "./tooltip";
import { Camera } from "./camera";
import { PrinterAnimator } from "./printer-animator";
import { Picker } from "./picker";
import { FloorRenderer, type BuildTarget, type Layers, type Look, type Motion } from "./floor-renderer";
import type { PaneInfo, Snapshot } from "@kauak/protocol";
import "./scene.css";

export type { BuildTarget };

export class OfficeScene {
  readonly app = new Application();
  /** Carries the world in when the elevator arrives at a floor; the camera moves both. */
  private lift = new Container();
  readonly world = new Container();
  private layers: Layers = {
    ground: new Container(),
    platforms: new Container(),
    floor: new Container(),
    objects: new Container(),
    overlay: new Container(),
    labels: new Container(),
    motes: new Container(),
  };
  private office: Office | null = null;
  private tooltip = new Tooltip(document.getElementById("tip")!);
  private floorId: string | null = null;
  private snapshot: Snapshot | null = null;
  private look: Look = { theme: defaultTheme, characters: defaultCharacters, materials: { ...P.PALETTE } };
  private motion: Motion = { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches };
  private renderer = new FloorRenderer(this.layers, this.look, this.motion, (room, key, blocks) => this.printers.add(room, key, blocks));
  private camera = new Camera(this.app, this.lift, this.world, this.motion);
  private printers = new PrinterAnimator(this.app, this.world, this.layers.objects, this.look, this.motion, () => this.prints);
  private picker = new Picker(this.layers.overlay, this.tooltip, this.look, () => this.prints, {
    onSelectPane: (pane) => this.onSelectPane(pane),
    onHoverPane: (paneId) => this.onHoverPane(paneId),
    onEmptyClick: () => this.onEmptyClick(),
    onBuild: (target, x, y) => this.onBuild(target, x, y),
    onOpenPrinter: (key, room, label) => this.onOpenPrinter(key, room, label),
  });
  private building = false;
  /** What the printers print; set by the page. */
  prints: Prints | null = null;
  onSelectPane: (pane: PaneInfo) => void = () => {};
  onHoverPane: (paneId: string | null) => void = () => {};
  /** A click on the office itself, away from every desk. */
  onEmptyClick: () => void = () => {};
  /** A click on a build-mode slot, at screen point (x, y). */
  onBuild: (target: BuildTarget, x: number, y: number) => void = () => {};
  /** A click on a room's printer. */
  onOpenPrinter: (key: string, room: string, label: string) => void = () => {};

  async init(host: HTMLElement) {
    await this.app.init({
      resizeTo: host,
      antialias: true,
      background: hex(this.look.theme.palette.background),
      backgroundAlpha: 0,
      resolution: devicePixelRatio,
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    const { ground, platforms, floor, objects, overlay, labels, motes } = this.layers;
    objects.sortableChildren = true;
    this.world.addChild(ground, platforms, floor, objects, overlay, labels, motes);
    // The stage is interactive (for panning), so Pixi hit-tests everything drawn
    // under it. Only desks take clicks: without this, the hover ring (drawn over
    // the hovered desk) or a label would swallow a click meant for a desk.
    for (const layer of [ground, platforms, floor, overlay, labels, motes]) layer.eventMode = "none";
    this.lift.addChild(this.world);
    this.app.stage.addChild(this.lift);
    this.camera.attach();
    this.picker.attach(this.app.stage);
    this.app.ticker.add((tk) => this.tick(tk.deltaMS / 1000));
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) => {
      this.motion.reduced = e.matches;
      if (this.snapshot) this.setSnapshot(this.snapshot);
    });
  }

  /** A visual change reuses snapshot, pane IDs, animation state, selection and camera. */
  setAppearance(theme: Theme, characters: Characters) {
    this.look.theme = theme;
    this.look.characters = characters;
    this.look.materials = Object.fromEntries(Object.entries(theme.materials).map(([k, c]) => [k, hex(c)])) as unknown as P.MaterialPalette;
    // Assigning a Pixi background color also resets its alpha to one.
    this.app.renderer.background.color = hex(theme.palette.background);
    this.app.renderer.background.alpha = 0;
    document.documentElement.style.setProperty("--bg", theme.palette.background);
    document.documentElement.style.setProperty("--accent", theme.palette.accent);
    if (this.snapshot) this.setSnapshot(this.snapshot);
  }

  setBanner(banner: BrandBanner | null, image: HTMLImageElement | null) {
    const previous = this.renderer.setBanner(banner, image);
    if (this.snapshot) this.setSnapshot(this.snapshot);
    if (previous) previous.destroy(true);
  }

  previewBanner() {
    const at = this.renderer.brandPoint;
    if (at) this.camera.lookAt(at);
  }

  // ------------------------------------------------------------ camera

  zoomAt(factor: number, mx?: number, my?: number) {
    this.camera.zoomAt(factor, mx, my);
  }

  /** Animate the camera so the whole office fits. */
  fit() {
    this.camera.fit(this.office);
  }

  /** Animate the camera onto one desk. */
  focusPane(paneId: string) {
    const node = this.renderer.nodes.find((n) => n.desk.pane.pane_id === paneId);
    if (node) this.camera.focus(node.anchor);
  }

  // ------------------------------------------------------------ selection

  setSelected(paneId: string | null) {
    this.picker.select(paneId);
  }

  // ------------------------------------------------------------ building

  /**
   * Show one floor. Changing floors refits the camera and slides the new floor
   * in from above (`dir` 1, going up) or below (-1). `runtime` names what runs
   * it, for the tooltip.
   */
  showFloor(floorId: string, snap: Snapshot, dir = 0, runtime = "") {
    this.tooltip.runtime = runtime;
    if (floorId !== this.floorId) {
      this.floorId = floorId;
      this.camera.newFloor(dir);
    }
    this.setSnapshot(snap);
  }

  /** Build mode: "+" slots for a new desk in every room and a new room in every wing. */
  setBuildMode(on: boolean) {
    if (on === this.building) return;
    this.building = on;
    if (this.snapshot) this.setSnapshot(this.snapshot);
  }

  private setSnapshot(snap: Snapshot) {
    this.snapshot = snap;
    const office = buildOffice(snap, this.building);
    this.office = office;
    const now = performance.now();
    this.renderer.clear();
    this.printers.clear();
    // The object under the tooltip is gone; Pixi re-sends pointerover to its replacement.
    this.tooltip.hide();
    this.renderer.draw(office, snap, now);
    this.camera.settle(office);
    this.renderer.buildMotes(office);
    this.picker.track(this.renderer.nodes, this.printers.nodes, this.renderer.slots);
  }

  // ------------------------------------------------------------ printers

  /** Where a printer's top sheet is on screen (CSS px) and the zoom; null when that room's printer is not drawn. */
  printerTray(key: string, room: string): Tray | null {
    return this.printers.tray(key, room);
  }

  // ------------------------------------------------------------ every frame

  private tick(dt: number) {
    if (this.motion.reduced) dt = 0;
    const now = this.motion.reduced ? 0 : performance.now();
    // The selection marker follows the person the desks' tick just moved.
    this.renderer.tickDesks(dt, now);
    this.printers.tick(now);
    this.renderer.tickRooms(now);
    this.picker.tick(now);
    this.renderer.tickMotes(dt);
    this.camera.tick(dt, now);
  }
}
