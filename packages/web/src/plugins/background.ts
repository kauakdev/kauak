import alpine from "../backgrounds/alpine.svg?url";
import summit from "../backgrounds/summit.svg?url";
import contours from "../backgrounds/contours.svg?url";
import "./background.css";

export const BACKGROUNDS = [
  { id: "alpine", name: "Alpine dusk", description: "Blue ridges fading into a quiet valley.", image: alpine },
  { id: "summit", name: "Moonlit summit", description: "Sharp peaks, icy light and a deep night sky.", image: summit },
  { id: "contours", name: "Contour map", description: "Subtle elevation lines for a quieter workspace.", image: contours },
  { id: "original", name: "Original", description: "The office package’s plain background.", image: null },
] as const;
export type BackgroundId = (typeof BACKGROUNDS)[number]["id"];
const STORAGE_KEY = "kauak.background.v1";
function isBackground(value: string | null): value is BackgroundId {
  return BACKGROUNDS.some((b) => b.id === value);
}

/** Fixed scenery behind the transparent office canvas, independent of its camera. */
export class OfficeBackground {
  private layer = document.createElement("div");
  private selected: BackgroundId = "original";
  constructor(host: HTMLElement) {
    this.layer.id = "office-background";
    this.layer.setAttribute("aria-hidden", "true");
    host.prepend(this.layer);
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(STORAGE_KEY);
    } catch {}
    const preview = new URLSearchParams(location.search).get("background");
    this.apply(isBackground(preview) ? preview : isBackground(saved) ? saved : "original");
  }
  get value() {
    return this.selected;
  }
  choose(id: BackgroundId): boolean {
    this.apply(id);
    // A preview link describes the initial view. Once chosen, a reload uses the saved choice.
    const url = new URL(location.href);
    url.searchParams.delete("background");
    history.replaceState(history.state, "", url);
    try {
      localStorage.setItem(STORAGE_KEY, id);
      return true;
    } catch {
      return false;
    }
  }
  private apply(id: BackgroundId) {
    this.selected = id;
    const option = BACKGROUNDS.find((b) => b.id === id)!;
    this.layer.dataset.background = id;
    this.layer.style.backgroundImage = option.image ? `url("${option.image}")` : "none";
  }
}
