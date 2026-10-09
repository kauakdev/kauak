/** Public, data-only API of appearance packages. No scene, Pixi, bridge or session imports. */
export type Capability = "office.theme" | "office.characters";
export type Status = "working" | "idle" | "blocked" | "done" | "unknown";
export interface BannerAnchor {
  id: string;
  name: string;
  origin: "campus" | "first-room";
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  facing: "x" | "y";
}
export interface Theme {
  apiVersion: 1;
  palette: {
    background: string;
    ground: string;
    groundLine: string;
    path: string;
    wall: string;
    accent: string;
    focus: string;
    light: string;
    rugs: string[];
    wings: string[];
  };
  materials: {
    wood: string;
    woodDark: string;
    metal: string;
    chair: string;
    pot: string;
    leaf: string;
    leafDark: string;
    paper: string;
    screenOff: string;
    white: string;
  };
  architecture: {
    wallHeight: number;
    floorPattern: "checker" | "inset" | "planks";
    decor: "botanical" | "technical" | "alpine";
    lightIntensity: number;
  };
  bannerAnchors: BannerAnchor[];
}
export interface Characters {
  apiVersion: 1;
  model: "human" | "robot" | "climber";
  skin: string[];
  hair: string[];
  shell: string;
  visor: string;
  animation: { tempo: Record<Status, number>; amplitude: number; glyphs: string[] };
}
export interface AppearancePackage {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  capabilities: { "office.theme"?: Theme; "office.characters"?: Characters };
}
export interface BrandBanner {
  dataUrl: string;
  name: string;
  width: number;
  height: number;
  anchorId: string;
  visible: boolean;
  background: "light" | "dark";
}
export interface Preferences {
  schemaVersion: 1;
  selections: Record<Capability, string>;
  packages: AppearancePackage[];
  banner: BrandBanner | null;
}
export const CAPABILITIES: Record<Capability, { defaultId: string }> = {
  "office.theme": { defaultId: "kauak.classic" },
  "office.characters": { defaultId: "kauak.classic" },
};
