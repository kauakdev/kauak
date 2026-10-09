import {
  CAPABILITIES,
  type AppearancePackage,
  type BannerAnchor,
  type BrandBanner,
  type Capability,
  type Characters,
  type Preferences,
  type Theme,
} from "./contracts";

export const SETTINGS_KEY = "kauak.appearance.v1";
// Included packages use kauak.*, so an imported package cannot shadow one.
const RESERVED_PREFIX = "kauak.";
export const MAX_PACKAGE_BYTES = 64 * 1024;
export const MAX_PACKAGES = 8;
export const MAX_BANNER_BYTES = 1_500_000;
const statuses = ["working", "idle", "blocked", "done", "unknown"] as const;
const fail = (path: string, message: string): never => {
  throw new Error(`${path}: ${message}`);
};
function object(v: unknown, p: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(p, "expected an object");
  return v as Record<string, unknown>;
}
function keys(v: Record<string, unknown>, allowed: string[], p: string) {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) fail(`${p}.${key}`, "unsupported field");
}
function str(v: unknown, p: string, max = 160): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) fail(p, `expected text of 1–${max} characters`);
  return v as string;
}
function id(v: unknown, p: string): string {
  const s = str(v, p, 80);
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(s)) fail(p, "use lowercase letters, numbers, dots or hyphens");
  return s;
}
function num(v: unknown, p: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) fail(p, `expected a number between ${min} and ${max}`);
  return v as number;
}
function choice<T extends string>(v: unknown, allowed: readonly T[], p: string): T {
  if (!allowed.includes(v as T)) fail(p, `expected ${allowed.join(" or ")}`);
  return v as T;
}
function version(v: unknown, p: string): 1 {
  if (v !== 1) fail(p, "only version 1 is supported");
  return 1;
}
function color(v: unknown, p: string): string {
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) fail(p, "expected #RRGGBB");
  return (v as string).toLowerCase();
}
function colors(v: unknown, p: string): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 12) fail(p, "expected 1–12 colors");
  return (v as unknown[]).map((c, i) => color(c, `${p}[${i}]`));
}
function colorObject(v: unknown, fields: string[], p: string) {
  const o = object(v, p);
  keys(o, fields, p);
  return Object.fromEntries(fields.map((k) => [k, color(o[k], `${p}.${k}`)]));
}
function anchor(v: unknown, p: string): BannerAnchor {
  const a = object(v, p);
  keys(a, ["id", "name", "origin", "x", "y", "z", "width", "height", "facing"], p);
  return {
    id: id(a.id, `${p}.id`),
    name: str(a.name, `${p}.name`, 60),
    origin: choice(a.origin, ["campus", "first-room"], `${p}.origin`),
    x: num(a.x, `${p}.x`, -3, 8),
    y: num(a.y, `${p}.y`, -3, 8),
    z: num(a.z, `${p}.z`, 0, 40),
    width: num(a.width, `${p}.width`, 1, 7),
    height: num(a.height, `${p}.height`, 20, 64),
    facing: choice(a.facing, ["x", "y"], `${p}.facing`),
  };
}
function theme(v: unknown): Theme {
  const p = "office.theme",
    o = object(v, p);
  keys(o, ["apiVersion", "palette", "materials", "architecture", "bannerAnchors"], p);
  const pal = object(o.palette, `${p}.palette`),
    fields = ["background", "ground", "groundLine", "path", "wall", "accent", "focus", "light"];
  keys(pal, [...fields, "rugs", "wings"], `${p}.palette`);
  const palette = {
    ...Object.fromEntries(fields.map((k) => [k, color(pal[k], `${p}.palette.${k}`)])),
    rugs: colors(pal.rugs, `${p}.palette.rugs`),
    wings: colors(pal.wings, `${p}.palette.wings`),
  } as Theme["palette"];
  const materials = colorObject(
    o.materials,
    ["wood", "woodDark", "metal", "chair", "pot", "leaf", "leafDark", "paper", "screenOff", "white"],
    `${p}.materials`,
  ) as Theme["materials"];
  const a = object(o.architecture, `${p}.architecture`);
  keys(a, ["wallHeight", "floorPattern", "decor", "lightIntensity"], `${p}.architecture`);
  if (!Array.isArray(o.bannerAnchors) || o.bannerAnchors.length < 1 || o.bannerAnchors.length > 4)
    fail(`${p}.bannerAnchors`, "expected 1–4 banner locations");
  const anchors = (o.bannerAnchors as unknown[]).map((v, i) => anchor(v, `${p}.bannerAnchors[${i}]`));
  if (new Set(anchors.map((a) => a.id)).size !== anchors.length) fail(`${p}.bannerAnchors`, "duplicate location id");
  return {
    apiVersion: version(o.apiVersion, `${p}.apiVersion`),
    palette,
    materials,
    bannerAnchors: anchors,
    architecture: {
      wallHeight: num(a.wallHeight, `${p}.architecture.wallHeight`, 24, 48),
      floorPattern: choice(a.floorPattern, ["checker", "inset", "planks"], `${p}.architecture.floorPattern`),
      decor: choice(a.decor, ["botanical", "technical", "alpine"], `${p}.architecture.decor`),
      lightIntensity: num(a.lightIntensity, `${p}.architecture.lightIntensity`, 0, 1),
    },
  };
}
function characters(v: unknown): Characters {
  const p = "office.characters",
    o = object(v, p);
  keys(o, ["apiVersion", "model", "skin", "hair", "shell", "visor", "animation"], p);
  const a = object(o.animation, `${p}.animation`);
  keys(a, ["tempo", "amplitude", "glyphs"], `${p}.animation`);
  const tempo = object(a.tempo, `${p}.animation.tempo`);
  keys(tempo, [...statuses], `${p}.animation.tempo`);
  if (!Array.isArray(a.glyphs) || a.glyphs.length < 1 || a.glyphs.length > 16) fail(`${p}.animation.glyphs`, "expected 1–16 glyphs");
  return {
    apiVersion: version(o.apiVersion, `${p}.apiVersion`),
    model: choice(o.model, ["human", "robot", "climber"], `${p}.model`),
    skin: colors(o.skin, `${p}.skin`),
    hair: colors(o.hair, `${p}.hair`),
    shell: color(o.shell, `${p}.shell`),
    visor: color(o.visor, `${p}.visor`),
    animation: {
      tempo: Object.fromEntries(
        statuses.map((s) => [s, num(tempo[s], `${p}.animation.tempo.${s}`, 0, 3)]),
      ) as Characters["animation"]["tempo"],
      amplitude: num(a.amplitude, `${p}.animation.amplitude`, 0, 2),
      glyphs: (a.glyphs as unknown[]).map((g, i) => str(g, `${p}.animation.glyphs[${i}]`, 4)),
    },
  };
}

/** Reconstruct every accepted field: no prototype keys, executable code or resource URLs. */
export function validateManifest(value: unknown, trusted = false): AppearancePackage {
  const o = object(value, "package");
  keys(o, ["schemaVersion", "id", "name", "version", "description", "capabilities"], "package");
  const packageId = id(o.id, "package.id");
  if (!trusted && packageId.startsWith(RESERVED_PREFIX)) fail("package.id", "kauak.* is reserved for included packages");
  const ver = str(o.version, "package.version", 32);
  if (!/^\d+\.\d+\.\d+$/.test(ver)) fail("package.version", "expected a version such as 1.0.0");
  const caps = object(o.capabilities, "package.capabilities");
  keys(caps, Object.keys(CAPABILITIES), "package.capabilities");
  if (!Object.keys(caps).length) fail("package.capabilities", "declare at least one capability");
  const capabilities: AppearancePackage["capabilities"] = {};
  if (caps["office.theme"] !== undefined) capabilities["office.theme"] = theme(caps["office.theme"]);
  if (caps["office.characters"] !== undefined) capabilities["office.characters"] = characters(caps["office.characters"]);
  return {
    schemaVersion: version(o.schemaVersion, "package.schemaVersion"),
    id: packageId,
    name: str(o.name, "package.name", 60),
    version: ver,
    description: str(o.description, "package.description", 240),
    capabilities,
  };
}

export function parsePackage(text: string): AppearancePackage {
  if (new TextEncoder().encode(text).byteLength > MAX_PACKAGE_BYTES) fail("package", "file exceeds 64 KB");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    fail("package", "choose a valid JSON file");
  }
  return validateManifest(v);
}

export class AppearanceRegistry {
  private entries = new Map<string, AppearancePackage>();
  readonly warnings: string[] = [];
  constructor(builtins: unknown[], custom: unknown[] = []) {
    for (const v of builtins)
      try {
        this.register(v, true);
      } catch (e) {
        this.warnings.push(`Skipped an included package: ${(e as Error).message}`);
      }
    for (const v of custom)
      try {
        this.register(v);
      } catch (e) {
        this.warnings.push(`Skipped a saved package: ${(e as Error).message}`);
      }
    for (const [cap, meta] of Object.entries(CAPABILITIES))
      if (!this.entries.get(meta.defaultId)?.capabilities[cap as Capability]) throw new Error(`Missing default for ${cap}`);
  }
  register(value: unknown, trusted = false): AppearancePackage {
    const p = validateManifest(value, trusted);
    if (this.entries.has(p.id)) throw new Error(`Package ${p.id} is already installed. Remove the custom package before replacing it.`);
    this.entries.set(p.id, p);
    return p;
  }
  list(cap: Capability) {
    return [...this.entries.values()].filter((p) => p.capabilities[cap]);
  }
  resolve(cap: Capability, requested: string) {
    const p = this.entries.get(requested);
    if (p?.capabilities[cap]) return { package: p, fallback: false };
    return { package: this.entries.get(CAPABILITIES[cap].defaultId)!, fallback: true };
  }
}

export function defaults(): Preferences {
  return {
    schemaVersion: 1,
    selections: Object.fromEntries(Object.entries(CAPABILITIES).map(([k, m]) => [k, m.defaultId])) as Preferences["selections"],
    packages: [],
    banner: null,
  };
}
export function validateBanner(value: unknown): BrandBanner {
  const b = object(value, "banner");
  const dataUrl = str(b.dataUrl, "banner.image", MAX_BANNER_BYTES);
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) fail("banner.image", "expected a locally processed PNG image");
  const width = num(b.width, "banner.width", 1, 1600),
    height = num(b.height, "banner.height", 1, 800);
  if (!Number.isInteger(width) || !Number.isInteger(height) || typeof b.visible !== "boolean") fail("banner", "invalid size or visibility");
  return {
    dataUrl,
    name: str(b.name, "banner.name", 120),
    width,
    height,
    anchorId: id(b.anchorId, "banner.location"),
    visible: b.visible as boolean,
    background: b.background === undefined ? "light" : choice(b.background, ["light", "dark"], "banner.background"),
  };
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function loadPreferences(storage: StorageLike): { value: Preferences; warnings: string[] } {
  try {
    return readPreferences(storage.getItem(SETTINGS_KEY));
  } catch {
    return { value: defaults(), warnings: ["Saved appearance settings could not be read. Included packages are being used."] };
  }
}
/** A saved package or banner that fails is skipped with a warning; settings that cannot be read at all throw. */
function readPreferences(raw: string | null): { value: Preferences; warnings: string[] } {
  const value = defaults(),
    warnings: string[] = [];
  if (!raw) return { value, warnings };
  if (raw.length > MAX_BANNER_BYTES + MAX_PACKAGE_BYTES * MAX_PACKAGES + 4096) throw new Error("saved settings exceed the size limit");
  const o = object(JSON.parse(raw), "settings");
  version(o.schemaVersion, "settings.schemaVersion");
  const s = object(o.selections, "settings.selections");
  // Only the capabilities this version has are read, so a selection saved for one it
  // no longer has (terminal.provider, in earlier versions) is dropped.
  for (const cap of Object.keys(CAPABILITIES) as Capability[]) {
    const selected = s[cap];
    if (typeof selected === "string") value.selections[cap] = selected;
  }
  if (Array.isArray(o.packages))
    for (const p of o.packages.slice(0, MAX_PACKAGES)) {
      try {
        value.packages.push(parsePackage(JSON.stringify(p)));
      } catch (e) {
        warnings.push(`Skipped a saved package: ${(e as Error).message}`);
      }
    }
  if (o.banner != null)
    try {
      value.banner = validateBanner(o.banner);
    } catch {
      warnings.push("The saved banner could not be restored. Upload it again.");
    }
  return { value, warnings };
}
export function savePreferences(storage: StorageLike, value: Preferences): string | null {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(value));
    return null;
  } catch {
    return "This browser could not save the change. Free some site storage or allow local storage, then try again.";
  }
}
export function resolveAnchor(theme: Theme, preferred: string) {
  return theme.bannerAnchors.find((a) => a.id === preferred) ?? theme.bannerAnchors[0]!;
}
export const hex = (v: string) => Number.parseInt(v.slice(1), 16);
