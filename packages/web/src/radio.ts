// Office radio: lofi internet stations on an FM dial. Between stations the
// speaker plays static; as the needle nears a station its stream fades in
// through a low-pass filter that opens up as the signal locks, like tuning a
// real set. It's off until turned on, and then the browser fetches the tuned
// stream straight from the station's server. stations.ts lists the stations
// and how they're chosen.

import { STATIONS, type Station } from "./stations";

const MIN = 87.5,
  MAX = 108;
/** How far (MHz) from a station its signal still comes through. */
const REACH = 0.8;
/** Loudness of pure static next to a locked station. */
const STATIC = 0.2;
/** Knob rotation per MHz; the whole band is a few turns, like a real tuner. */
const TURN_PER_MHZ = 70;
const KEY = "agent-office.radio";

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  tone: BiquadFilterNode;
  hiss: GainNode;
}
interface Saved {
  freq?: unknown;
  volume?: unknown;
  on?: unknown;
}

export class Radio {
  private card = document.getElementById("radio")!;
  private toggle = document.getElementById("btn-radio")!;
  private dial = document.getElementById("radio-dial")!;
  private scale = document.getElementById("radio-scale")!;
  private needle = document.getElementById("radio-needle")!;
  private knob = document.getElementById("radio-knob")!;
  private powerBtn = document.getElementById("radio-power")!;
  private volume = document.getElementById("radio-volume") as HTMLInputElement;
  private freqEl = document.getElementById("radio-freq")!;
  private nameEl = document.getElementById("radio-name")!;
  private infoEl = document.getElementById("radio-info")!;
  private credit = document.getElementById("radio-credit")!;
  private bars = [...this.card.querySelectorAll<HTMLElement>(".bars i")];
  private audio = new Audio();
  private graph: Graph | null = null;
  private freq = STATIONS[0]!.freq;
  private on = false;
  /** Was on before a reload; waits for a click or key, since browsers block audio until one. */
  private wantResume = false;
  /** Station whose stream is loaded or loading; null between stations. */
  private tuned: Station | null = null;
  /** The tuned stream is producing sound. */
  private live = false;
  private failed = false;
  private tuneTimer = 0;
  private settleTimer = 0;
  private offTimer = 0;
  private anim = 0;
  private target = 0;
  /** Set by main: true while the terminal panel owns the keyboard. */
  isTyping: () => boolean = () => false;

  constructor() {
    const saved = restore();
    const freq = typeof saved.freq === "number" ? Math.min(MAX, Math.max(MIN, saved.freq)) : null;
    // A saved frequency with no station in reach (static, or a station since taken off
    // the dial) starts back on the first station, switched off: the browser shouldn't
    // connect to a station nobody tuned to.
    const kept = freq !== null && this.reception(freq).station !== null;
    if (kept) this.freq = freq;
    if (typeof saved.volume === "number") this.volume.value = String(saved.volume);

    const pct = (f: number) => `${((f - MIN) / (MAX - MIN)) * 100}%`;
    let marks = "";
    for (let f = 88; f <= 108; f++) {
      marks += `<i class="tick${f % 4 === 0 ? " major" : ""}" style="left:${pct(f)}"></i>`;
      if (f % 4 === 0) marks += `<span class="num" style="left:${pct(f)}">${f}</span>`;
    }
    for (const s of STATIONS) marks += `<b class="st" style="left:${pct(s.freq)}" title="${s.freq} · ${s.name}"></b>`;
    this.scale.insertAdjacentHTML("afterbegin", marks);

    // Credit each station, and say where the sound comes from before anyone turns it on.
    const host = (s: Station) => new URL(s.site).host;
    for (const s of STATIONS) {
      const line = document.createElement("p"),
        link = document.createElement("a");
      Object.assign(link, { href: s.site, target: "_blank", rel: "noopener noreferrer", textContent: host(s) });
      line.append(`Stream: ${s.name} · `, link);
      this.credit.append(line);
    }
    const hosts = [...new Set(STATIONS.map(host))],
      note = document.createElement("p");
    note.textContent = `Plays straight from ${hosts.join(", ")}; your browser connects to ${hosts.length > 1 ? "them" : "it"} directly.`;
    this.credit.append(note);

    this.audio.crossOrigin = "anonymous";
    this.audio.preload = "none";
    this.audio.addEventListener("playing", () => {
      this.live = true;
      this.failed = false;
      this.update();
    });
    for (const ev of ["waiting", "emptied", "pause"])
      this.audio.addEventListener(ev, () => {
        this.live = false;
        this.update();
      });
    this.audio.addEventListener("error", () => {
      if (!this.audio.getAttribute("src")) return;
      this.live = false;
      this.failed = true;
      this.update();
      // Streams drop now and then; try again while the dial stays on the station.
      const station = this.tuned;
      window.setTimeout(() => {
        if (this.on && this.failed && this.tuned === station) this.load(station);
      }, 5000);
    });

    this.toggle.addEventListener("click", () => this.show(this.card.hidden));
    this.powerBtn.addEventListener("click", () => this.power(!this.lit));
    document.getElementById("radio-prev")!.addEventListener("click", () => this.seek(-1));
    document.getElementById("radio-next")!.addEventListener("click", () => this.seek(1));
    this.volume.addEventListener("input", () => {
      this.update();
      this.persist();
    });

    // Drag along the dial window to put the needle there; drag the knob (either axis) to turn it.
    this.drag(this.dial, (e) => {
      const r = this.scale.getBoundingClientRect();
      this.setFreq(MIN + ((e.clientX - r.left) / r.width) * (MAX - MIN));
    });
    this.drag(this.knob, (_, dx, dy) => {
      if (!dx && !dy) this.knob.focus();
      else this.setFreq(this.freq + (dx - dy) * 0.025);
    });
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      this.stopSweep();
      this.setFreq(this.freq - Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 100) * 0.0015);
      window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => this.settle(), 350);
    };
    this.dial.addEventListener("wheel", wheel, { passive: false });
    this.knob.addEventListener("wheel", wheel, { passive: false });
    this.knob.addEventListener("keydown", (e) => {
      const fine = (d: number) => {
        this.stopSweep();
        this.setFreq(Math.round((this.freq + d) * 10) / 10);
        this.persist();
      };
      const keys: Record<string, () => void> = {
        ArrowRight: () => fine(0.1),
        ArrowUp: () => fine(0.1),
        ArrowLeft: () => fine(-0.1),
        ArrowDown: () => fine(-0.1),
        PageUp: () => this.seek(1),
        PageDown: () => this.seek(-1),
        Home: () => fine(MIN - this.freq),
        End: () => fine(MAX - this.freq),
      };
      const act = keys[e.key];
      if (!act) return;
      e.preventDefault();
      e.stopPropagation(); // arrows and PageUp/Down also step desks and floors
      act();
    });

    addEventListener("keydown", (e) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        this.isTyping() ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      if (e.key === "m") this.power(!this.lit);
    });
    // Capture phase, so Esc closes the radio before it can close the terminal panel.
    addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape" && !this.card.hidden && !this.isTyping()) {
          e.stopPropagation();
          this.show(false);
        }
      },
      true,
    );
    addEventListener("pointerdown", (e) => {
      const t = e.target as Node;
      if (!this.card.hidden && !this.card.contains(t) && !this.toggle.contains(t)) this.show(false);
    });

    if (saved.on === true && kept) {
      this.wantResume = true;
      // Registered after the M handler, so a first M press turns the radio off instead of resuming it.
      const resume = (e: Event) => {
        if (this.powerBtn.contains(e.target as Node)) return; // its click toggles power itself
        removeEventListener("pointerdown", resume);
        removeEventListener("keydown", resume);
        if (this.wantResume) this.power(true);
      };
      addEventListener("pointerdown", resume);
      addEventListener("keydown", resume);
    }
    this.update();
  }

  /** On as the user sees it, including waiting to resume after a reload. */
  private get lit() {
    return this.on || this.wantResume;
  }

  private show(open: boolean) {
    this.card.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
  }

  private power(on: boolean) {
    this.wantResume = false;
    this.on = on;
    window.clearTimeout(this.offTimer);
    if (on) {
      this.graph ??= this.build();
      void this.graph.ctx.resume();
      const { station } = this.reception();
      if (station !== this.tuned || !this.live) this.load(station);
      else this.update();
    } else {
      this.update(); // fades out
      this.offTimer = window.setTimeout(() => {
        this.load(null);
        void this.graph?.ctx.suspend();
      }, 250);
    }
    this.persist();
  }

  private build(): Graph {
    const ctx = new AudioContext();
    const master = new GainNode(ctx, { gain: 0 });
    master.connect(ctx.destination);
    // Static: looped white noise squeezed into a small speaker's band.
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = new AudioBufferSourceNode(ctx, { buffer, loop: true });
    const hiss = new GainNode(ctx, { gain: 0 });
    noise
      .connect(new BiquadFilterNode(ctx, { type: "bandpass", frequency: 2200, Q: 0.5 }))
      .connect(hiss)
      .connect(master);
    noise.start();
    const tone = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 500 });
    const music = new GainNode(ctx, { gain: 0 });
    ctx.createMediaElementSource(this.audio).connect(tone).connect(music).connect(master);
    return { ctx, master, music, tone, hiss };
  }

  private setFreq(f: number) {
    this.freq = Math.min(MAX, Math.max(MIN, f));
    const { station } = this.reception();
    if (this.on && station !== this.tuned) {
      window.clearTimeout(this.tuneTimer);
      // Let the needle rest first, so sweeping across the band doesn't open every stream on the way.
      this.tuneTimer = window.setTimeout(() => {
        const now = this.reception().station;
        if (this.on && now !== this.tuned) this.load(now);
      }, 300);
    }
    this.update();
  }

  private load(station: Station | null) {
    window.clearTimeout(this.tuneTimer);
    this.tuned = station;
    this.live = false;
    this.failed = false;
    if (station && this.on) {
      this.audio.src = station.url;
      this.audio.play().catch(() => {}); // superseded by a newer load or power-off
    } else if (this.audio.getAttribute("src")) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load(); // drops the connection, not just the playback
    }
    this.update();
  }

  /** Nearest station within reach, and how cleanly it comes in (0..1). */
  private reception(freq = this.freq): { station: Station | null; signal: number } {
    let best: Station | null = null,
      d = Infinity;
    for (const s of STATIONS) {
      const x = Math.abs(s.freq - freq);
      if (x < d) {
        d = x;
        best = s;
      }
    }
    return d < REACH ? { station: best, signal: 1 - d / REACH } : { station: null, signal: 0 };
  }

  /** Pull a nearly tuned needle onto the station, like a set's fine-tune. */
  private settle() {
    const { station } = this.reception();
    if (station && Math.abs(station.freq - this.freq) > 0.01) this.sweepTo(station.freq, 180);
    else this.persist();
  }

  private seek(dir: 1 | -1) {
    const from = this.anim ? this.target : this.freq;
    const list = dir > 0 ? STATIONS : [...STATIONS].reverse();
    const next = list.find((s) => (dir > 0 ? s.freq > from + 0.05 : s.freq < from - 0.05)) ?? list[0]!;
    this.sweepTo(next.freq, Math.min(1400, 250 + Math.abs(next.freq - this.freq) * 70));
  }

  private sweepTo(target: number, ms: number) {
    this.stopSweep();
    this.target = target;
    const from = this.freq,
      t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      this.setFreq(from + (target - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
      if (k < 1) this.anim = requestAnimationFrame(step);
      else {
        this.anim = 0;
        this.persist();
      }
    };
    this.anim = requestAnimationFrame(step);
  }

  private stopSweep() {
    cancelAnimationFrame(this.anim);
    this.anim = 0;
  }

  private drag(el: HTMLElement, move: (e: PointerEvent, dx: number, dy: number) => void) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.stopSweep();
      el.setPointerCapture(e.pointerId);
      let x = e.clientX,
        y = e.clientY;
      move(e, 0, 0);
      const onMove = (ev: PointerEvent) => {
        move(ev, ev.clientX - x, ev.clientY - y);
        x = ev.clientX;
        y = ev.clientY;
      };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        this.settle();
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    });
  }

  /** Mix the speaker and redraw the set. */
  private update() {
    const { station, signal } = this.reception();
    const heard = this.on && this.live && station === this.tuned ? signal : 0;
    const g = this.graph;
    if (g) {
      const t = g.ctx.currentTime,
        lag = 0.06;
      g.master.gain.setTargetAtTime(this.on ? (Number(this.volume.value) / 100) ** 2 : 0, t, lag);
      g.music.gain.setTargetAtTime(heard ** 1.5, t, lag);
      g.hiss.gain.setTargetAtTime(STATIC * (1 - heard) ** 2, t, lag);
      g.tone.frequency.setTargetAtTime(500 + heard ** 3 * 19500, t, lag);
    }

    const f = this.freq.toFixed(1);
    this.needle.style.left = `${((this.freq - MIN) / (MAX - MIN)) * 100}%`;
    this.knob.style.setProperty("--turn", `${(this.freq - MIN) * TURN_PER_MHZ}deg`);
    this.knob.setAttribute("aria-valuenow", f);
    this.knob.setAttribute("aria-valuetext", `${f} FM${station ? `, ${station.name}` : ""}`);
    this.freqEl.textContent = f;
    this.nameEl.textContent = station?.name ?? "—";
    this.infoEl.textContent = this.wantResume
      ? "click anywhere to resume"
      : !this.on
        ? (station?.genre ?? "between stations")
        : !station
          ? "static"
          : this.failed
            ? "no signal, retrying…"
            : heard > 0
              ? station.genre
              : "tuning…";
    this.bars.forEach((b, i) => {
      b.classList.toggle("lit", this.on && signal > i / this.bars.length);
    });
    this.card.dataset.state = !this.lit ? "off" : heard > 0.85 ? "locked" : "on";
    this.powerBtn.setAttribute("aria-pressed", String(this.lit));
    this.toggle.classList.toggle("on", this.lit);
    this.toggle.classList.toggle("playing", heard > 0);
    this.toggle.title = this.on && station ? `Radio · ${station.name}, ${station.freq} FM (M: on/off)` : "Radio (M: on/off)";
  }

  private persist() {
    const saved = { freq: Math.round(this.freq * 10) / 10, volume: Number(this.volume.value), on: this.lit };
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {}
  }
}

// localStorage can be missing or throw (private windows, blocked site data).
function restore(): Saved {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
