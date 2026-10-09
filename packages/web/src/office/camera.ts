// The office's camera. It pans `world` with a drag and zooms it with the wheel
// or the HUD, eases it onto a target (the whole floor, a desk, the banner), and
// brings a floor in when the elevator arrives by sliding `lift`, which carries
// `world`.

import type { Application, Container, PointData } from "pixi.js";
import { toScreen } from "./iso";
import type { Office } from "./layout";
import type { Motion } from "./floor-renderer";

interface CameraTarget {
  x: number;
  y: number;
  scale: number;
}

export class Camera {
  private camTarget: CameraTarget | null = null;
  /** Whether the floor on screen was fitted yet; the first fit jumps instead of easing. */
  private fitted = false;
  private arrival: { at: number; dir: number } | null = null;

  constructor(
    private app: Application,
    private lift: Container,
    private world: Container,
    private motion: Motion,
  ) {}

  /** Pans with a drag on the stage and zooms with the wheel; once the app is initialised. */
  attach() {
    const stage = this.app.stage;
    stage.eventMode = "static";
    stage.hitArea = { contains: () => true } as never;
    let drag: { x: number; y: number; wx: number; wy: number } | null = null;
    stage.on("pointerdown", (e) => {
      drag = { x: e.global.x, y: e.global.y, wx: this.world.x, wy: this.world.y };
      this.camTarget = null;
    });
    stage.on("pointerup", () => (drag = null));
    stage.on("pointerupoutside", () => (drag = null));
    stage.on("pointermove", (e) => {
      if (!drag) return;
      const dx = e.global.x - drag.x,
        dy = e.global.y - drag.y;
      this.world.x = drag.wx + dx;
      this.world.y = drag.wy + dy;
    });
    this.app.canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camTarget = null;
        this.zoomAt(Math.exp(-e.deltaY * 0.001), e.offsetX, e.offsetY);
      },
      { passive: false },
    );
  }

  zoomAt(factor: number, mx = this.app.screen.width / 2, my = this.app.screen.height / 2) {
    const next = Math.min(3, Math.max(0.3, this.world.scale.x * factor));
    const wx = (mx - this.world.x) / this.world.scale.x,
      wy = (my - this.world.y) / this.world.scale.y;
    this.world.scale.set(next);
    this.world.x = mx - wx * next;
    this.world.y = my - wy * next;
  }

  /** Animate the camera so the whole office fits. */
  fit(office: Office | null) {
    if (!office || office.w === 0) return;
    const corners = [toScreen(-1, -1), toScreen(office.w + 1, -1), toScreen(office.w + 1, office.h + 1), toScreen(-1, office.h + 1)];
    const minX = Math.min(...corners.map((c) => c.x)),
      maxX = Math.max(...corners.map((c) => c.x));
    const minY = Math.min(...corners.map((c) => c.y)) - 90,
      maxY = Math.max(...corners.map((c) => c.y)) + 40;
    const v = this.viewport();
    const scale = Math.min(2, Math.max(0.3, Math.min(v.w / (maxX - minX + 60), v.h / (maxY - minY + 60))));
    this.camTarget = { scale, x: v.cx - ((minX + maxX) / 2) * scale, y: v.cy - ((minY + maxY) / 2) * scale };
  }

  /** Visible canvas area once the HUD (roster, terminal panel, bars) is subtracted. */
  private viewport() {
    const sw = this.app.screen.width,
      sh = this.app.screen.height;
    const visible = (id: string) => {
      const el = document.getElementById(id);
      return el && getComputedStyle(el).opacity !== "0" && getComputedStyle(el).display !== "none" ? el.getBoundingClientRect() : null;
    };
    const roster = visible("roster");
    const left = roster && roster.right < sw * 0.5 ? roster.right + 8 : 0;
    const floors = visible("floors");
    const right = document.body.classList.contains("panel-open")
      ? document.getElementById("panel")!.offsetWidth
      : floors && sw >= 900 && floors.left > sw * 0.5
        ? sw - floors.left + 8
        : 0;
    const top = 52,
      bottom = 40;
    const w = Math.max(200, sw - left - right),
      h = Math.max(200, sh - top - bottom);
    return { w, h, cx: left + w / 2, cy: top + h / 2 };
  }

  /** Animate the camera onto one desk, whose selection marker is at `anchor`. */
  focus(anchor: PointData) {
    const scale = Math.max(this.world.scale.x, 1.3);
    const v = this.viewport();
    this.camTarget = { scale, x: v.cx - anchor.x * scale, y: v.cy - (anchor.y + 20) * scale };
  }

  /** Animate the camera onto the brand banner, whose middle is at `at`. */
  lookAt(at: PointData) {
    const v = this.viewport(),
      scale = Math.max(1.3, this.world.scale.x);
    this.camTarget = { scale, x: v.cx - at.x * scale, y: v.cy - at.y * scale };
  }

  /** Another floor is on screen: fit it on its first draw, and slide it in from above (`dir` 1) or below (-1). */
  newFloor(dir: number) {
    this.fitted = false;
    this.camTarget = null;
    if (dir !== 0) this.arrival = { at: performance.now(), dir };
  }

  /** After a draw: the first one of a floor fits the camera to it at once. */
  settle(office: Office) {
    if (!this.fitted && office.w > 0) {
      this.fit(office);
      if (this.camTarget) {
        this.world.scale.set(this.camTarget.scale);
        this.world.position.set(this.camTarget.x, this.camTarget.y);
        this.camTarget = null;
      }
      this.fitted = true;
    }
  }

  /** The arrival, then the easing onto the target. */
  tick(dt: number, now: number) {
    if (this.arrival) {
      const t = this.motion.reduced ? 1 : Math.min(1, (now - this.arrival.at) / 420);
      const e = 1 - (1 - t) ** 3;
      this.lift.alpha = e;
      this.lift.y = (1 - e) * -60 * this.arrival.dir;
      if (t >= 1) {
        this.arrival = null;
        this.lift.y = 0;
        this.lift.alpha = 1;
      }
    }
    if (this.camTarget) {
      const k = this.motion.reduced ? 1 : 1 - Math.exp(-dt * 6);
      const c = this.camTarget;
      const s = this.world.scale.x + (c.scale - this.world.scale.x) * k;
      this.world.scale.set(s);
      this.world.x += (c.x - this.world.x) * k;
      this.world.y += (c.y - this.world.y) * k;
      if (Math.abs(c.x - this.world.x) < 0.5 && Math.abs(c.y - this.world.y) < 0.5 && Math.abs(c.scale - s) < 0.001) this.camTarget = null;
    }
  }
}
