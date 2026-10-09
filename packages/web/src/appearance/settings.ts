import type { AppearancePackage, BrandBanner, Characters, Preferences, Theme } from "@kauak/appearance/contracts";
import {
  loadPreferences,
  MAX_PACKAGES,
  MAX_PACKAGE_BYTES,
  parsePackage,
  AppearanceRegistry,
  resolveAnchor,
  savePreferences,
  validateManifest,
} from "@kauak/appearance/registry";
import harbor from "@kauak/appearance/examples/harbor.json";
import { bundledPackages } from "./catalog";
import { decodeImage, prepareBanner } from "./banner-image";
import { BACKGROUNDS, type BackgroundId, type OfficeBackground } from "./background";
import { fetchInstalled, fileName, type Installed } from "./installed";
import "./settings.css";

interface AppearanceHost {
  setAppearance(theme: Theme, characters: Characters): void;
  setBanner(banner: BrandBanner | null, image: HTMLImageElement | null): void;
  previewBanner(): void;
}
export class AppearanceSettings {
  private dialog = document.createElement("dialog");
  private registry: AppearanceRegistry;
  private prefs: Preferences;
  private bannerImage: HTMLImageElement | null = null;
  private busy = false;
  private button = document.getElementById("btn-appearance")!;
  private startupWarnings: string[];
  /** The included packages, and the installed ones once loadInstalled has them; the saved ones go in a copy (buildRegistry). */
  private base = new AppearanceRegistry(bundledPackages);
  /** The packages installed on the machine that serves the page, once loadInstalled has asked; null with no bridge. */
  private installed: Installed | null = null;
  /** Each installed file as the settings list it: loaded, or why not. */
  private installedRows: { file: string; label: string; error: string | null }[] = [];
  /** The id of each installed package that loaded, and its file. */
  private installedIds = new Map<string, string>();
  private storage = { getItem: (k: string) => localStorage.getItem(k), setItem: (k: string, v: string) => localStorage.setItem(k, v) };

  constructor(
    private host: AppearanceHost,
    private background: OfficeBackground,
  ) {
    const loaded = loadPreferences(this.storage);
    this.prefs = loaded.value;
    const built = this.buildRegistry(this.prefs.packages);
    this.registry = built.registry;
    this.startupWarnings = [...loaded.warnings, ...this.base.warnings, ...built.warnings];
    this.dialog.id = "appearance";
    this.dialog.setAttribute("aria-labelledby", "appearance-title");
    this.dialog.innerHTML = `<header><div><h2 id="appearance-title">Make this office yours</h2><p>Choose the space, the team and a place for your company.</p></div><button class="btn" data-close aria-label="Close appearance settings">✕</button></header>
      <div class="appearance-body"><section><h3>Office & team</h3><p>Your sessions and agent states stay the same.</p>
        <div class="appearance-pair"><label>Office<select id="appearance-theme"></select><small id="theme-description"></small></label><label>Characters<select id="appearance-characters"></select><small id="characters-description"></small></label></div>
        <p id="appearance-fallback" class="appearance-warning" hidden></p>
      </section><section aria-labelledby="background-title"><h3 id="background-title">Beyond the office</h3><p>A little of the mountains, wherever you work.</p>
        <fieldset class="background-options" aria-labelledby="background-title">${BACKGROUNDS.map((b) => `<label class="background-choice"><input type="radio" name="office-background" value="${b.id}"><span class="background-swatch" aria-hidden="true" data-background-swatch="${b.id}"></span><span class="background-caption"><strong>${b.name}</strong><small>${b.description}</small></span></label>`).join("")}</fieldset>
        <div class="background-preview-actions"><small>Switch instantly to compare. Your choice stays on this browser.</small><button class="btn" id="background-view">View in office</button></div>
      </section><section><h3>Company banner</h3><p>Show a logo or banner on this floor. Images keep their proportions.</p>
        <div id="banner-preview"><span>No company image yet</span><img hidden alt="Your company banner preview"></div>
        <div class="appearance-pair"><label><span id="banner-upload-label">Choose an image</span><input id="banner-file" type="file" accept="image/png,image/jpeg,image/webp"><small>PNG, JPEG or WebP · up to 4 MB</small></label><label>Place it at<select id="banner-anchor"></select><small>Appears on every floor with rooms.</small></label></div>
        <label class="banner-background">Panel background<select id="banner-background"><option value="light">Light</option><option value="dark">Dark</option></select><small>Choose a background that makes your logo easy to read.</small></label>
        <div class="banner-actions"><label><input id="banner-visible" type="checkbox"> Show in office</label><button class="btn" id="banner-view">Show me</button><button class="btn" id="banner-remove">Remove image</button></div>
        <p id="banner-location-note" class="appearance-warning" hidden></p>
      </section><section><h3>More appearances</h3><p>An appearance package is a JSON file of colors and shapes, no code. Start from the example, then import it here or install it for every browser that opens this office.</p>
        <div class="appearance-pair"><label>Import a package<input id="package-file" type="file" accept=".json,application/json"><small>Kept on this browser · up to 64 KB</small></label><div class="appearance-example"><span>Start from an example</span><button class="btn" id="example-download">Download harbor.json</button><small>Change its id, name and colors.</small></div></div>
        <ul id="appearance-packages"></ul>
        <div id="installed" hidden><h4>Installed on this machine</h4><p id="installed-note"></p><ul id="installed-packages"></ul></div>
      </section>
      <p id="appearance-message" role="status" aria-live="polite">Changes are saved on this browser.</p></div><footer><span>Local to this browser. Your banner stays when you change office.</span><button class="btn primary" data-close>Done</button></footer>`;
    document.body.append(this.dialog);
    for (const b of BACKGROUNDS)
      if (b.image)
        this.dialog.querySelector<HTMLElement>(`[data-background-swatch="${b.id}"]`)!.style.backgroundImage = `url("${b.image}")`;
    this.button.addEventListener("click", () => {
      this.render();
      this.dialog.showModal();
      this.button.setAttribute("aria-expanded", "true");
      this.el<HTMLSelectElement>("appearance-theme").focus();
    });
    this.dialog.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", () => this.dialog.close());
    });
    this.dialog.addEventListener("close", () => {
      this.button.setAttribute("aria-expanded", "false");
      this.button.focus();
    });
    // Modal input owns all game shortcuts, including Escape, before other capture listeners.
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.isOpen()) e.stopImmediatePropagation();
      },
      true,
    );
    for (const [field, cap] of [
      ["appearance-theme", "office.theme"],
      ["appearance-characters", "office.characters"],
    ] as const)
      this.el(field).addEventListener("change", () =>
        this.commit({ ...this.prefs, selections: { ...this.prefs.selections, [cap]: this.el<HTMLSelectElement>(field).value } }),
      );
    this.dialog.querySelectorAll<HTMLInputElement>('input[name="office-background"]').forEach((input) => {
      input.addEventListener("change", () => {
        if (!input.checked) return;
        const saved = this.background.choose(input.value as BackgroundId);
        this.message(
          saved
            ? "Background saved on this browser. View it in the office."
            : "Background previewed. This browser could not save the choice.",
          !saved,
        );
      });
    });
    this.el("background-view").addEventListener("click", () => this.dialog.close());
    this.el("banner-file").addEventListener("change", () => void this.uploadBanner());
    this.el("package-file").addEventListener("change", () => void this.importPackage());
    this.el("example-download").addEventListener("click", () => this.downloadExample());
    this.el("banner-anchor").addEventListener("change", () => {
      if (this.prefs.banner)
        this.commit({ ...this.prefs, banner: { ...this.prefs.banner, anchorId: this.el<HTMLSelectElement>("banner-anchor").value } });
    });
    this.el("banner-visible").addEventListener("change", () => {
      if (this.prefs.banner)
        this.commit({ ...this.prefs, banner: { ...this.prefs.banner, visible: this.el<HTMLInputElement>("banner-visible").checked } });
    });
    this.el("banner-background").addEventListener("change", () => {
      if (this.prefs.banner)
        this.commit({
          ...this.prefs,
          banner: { ...this.prefs.banner, background: this.el<HTMLSelectElement>("banner-background").value as "light" | "dark" },
        });
    });
    this.el("banner-remove").addEventListener("click", () => {
      if (this.commit({ ...this.prefs, banner: null })) {
        this.bannerImage = null;
        this.host.setBanner(null, null);
      }
    });
    this.el("banner-view").addEventListener("click", () => {
      this.dialog.close();
      this.host.previewBanner();
    });
    this.render();
  }
  /**
   * Asks the bridge for the packages installed on its machine, then shows the
   * office in the saved appearance. Without a bridge (the demo site), the
   * included and the imported packages are all there is. Called once, when
   * the page loads, before the first frame.
   */
  async loadInstalled() {
    this.installed = await fetchInstalled();
    const base = new AppearanceRegistry(bundledPackages);
    this.installedRows = [];
    this.installedIds.clear();
    for (const p of this.installed?.packages ?? []) {
      try {
        if ("error" in p) throw new Error(p.error);
        const v = validateManifest(p.package),
          other = this.installedIds.get(v.id);
        if (other) throw new Error(`its id, ${v.id}, is taken by ${other}`);
        base.register(v);
        this.installedIds.set(v.id, p.file);
        this.installedRows.push({ file: p.file, label: `${v.name} · ${v.version}`, error: null });
      } catch (e) {
        // Its row in the settings says why; no warning on top of it.
        this.installedRows.push({ file: p.file, label: fileName(p.file), error: (e as Error).message });
      }
    }
    this.base = base;
    const built = this.buildRegistry(this.prefs.packages);
    this.registry = built.registry;
    this.startupWarnings.push(...[...base.warnings, ...built.warnings].filter((w) => !this.startupWarnings.includes(w)));
    this.apply();
    this.render();
  }
  async restoreBanner() {
    if (!this.prefs.banner) return;
    try {
      const b = this.prefs.banner,
        image = await decodeImage(b.dataUrl);
      if (image.naturalWidth !== b.width || image.naturalHeight !== b.height) throw new Error("invalid saved dimensions");
      this.bannerImage = image;
      this.host.setBanner(b, image);
    } catch {
      this.startupWarnings.push("The saved banner could not be displayed. Replace or remove the image.");
    }
    this.render();
  }
  isOpen() {
    return this.dialog.open;
  }
  private el<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.dialog.querySelector<T>(`#${id}`)!;
  }
  /**
   * The registry: the included and the installed packages (base, made once),
   * then the ones saved in this browser. A file wins over an import of the
   * same id: the import is left out, and its row says to remove it. A saved
   * package that fails otherwise is skipped with a warning.
   */
  private buildRegistry(saved: AppearancePackage[]) {
    const registry = this.base.copy(),
      warnings: string[] = [];
    for (const p of saved)
      try {
        if (!this.installedIds.has(p.id)) registry.register(p);
      } catch (e) {
        warnings.push(`Skipped a saved package: ${(e as Error).message}`);
      }
    return { registry, warnings };
  }
  private apply() {
    const theme = this.registry.resolve("office.theme", this.prefs.selections["office.theme"]).package.capabilities["office.theme"]!;
    const chars = this.registry.resolve("office.characters", this.prefs.selections["office.characters"]).package.capabilities[
      "office.characters"
    ]!;
    this.host.setAppearance(theme, chars);
    this.host.setBanner(this.prefs.banner, this.bannerImage);
  }
  private commit(next: Preferences): boolean {
    const error = savePreferences(this.storage, next);
    if (error) {
      this.message(error, true);
      this.render(false);
      return false;
    }
    this.prefs = next;
    this.registry = this.buildRegistry(next.packages).registry;
    this.startupWarnings = [];
    this.apply();
    this.render(false);
    this.message("Saved on this browser.");
    return true;
  }
  private message(text: string, error = false) {
    const el = this.el("appearance-message");
    el.textContent = text;
    el.classList.toggle("error", error);
    el.setAttribute("role", error ? "alert" : "status");
  }
  private render(showWarnings = true) {
    this.dialog.querySelectorAll<HTMLInputElement>('input[name="office-background"]').forEach((input) => {
      input.checked = input.value === this.background.value;
    });
    const fallback: string[] = [];
    for (const [field, cap, desc] of [
      ["appearance-theme", "office.theme", "theme-description"],
      ["appearance-characters", "office.characters", "characters-description"],
    ] as const) {
      const select = this.el<HTMLSelectElement>(field),
        result = this.registry.resolve(cap, this.prefs.selections[cap]);
      select.replaceChildren(...this.registry.list(cap).map((p) => new Option(p.name, p.id)));
      select.value = result.package.id;
      this.el(desc).textContent = result.package.description;
      if (result.fallback)
        fallback.push(`${cap === "office.theme" ? "Office" : "Characters"} was unavailable. Using ${result.package.name}.`);
    }
    const warning = this.el("appearance-fallback");
    warning.textContent = fallback.join(" ");
    warning.hidden = !fallback.length;
    const theme = this.registry.resolve("office.theme", this.prefs.selections["office.theme"]).package.capabilities["office.theme"]!;
    const banner = this.prefs.banner,
      anchor = this.el<HTMLSelectElement>("banner-anchor");
    const preferred = banner?.anchorId ?? theme.bannerAnchors[0]!.id,
      resolved = resolveAnchor(theme, preferred);
    anchor.replaceChildren(...theme.bannerAnchors.map((a) => new Option(a.name, a.id)));
    anchor.value = resolved.id;
    const note = this.el("banner-location-note");
    note.hidden = !banner || resolved.id === preferred;
    note.textContent = `This office uses ${resolved.name}. Your original location will return with an office that supports it.`;
    const img = this.dialog.querySelector<HTMLImageElement>("#banner-preview img")!,
      empty = this.dialog.querySelector<HTMLElement>("#banner-preview span")!;
    img.hidden = !banner || !this.bannerImage;
    empty.hidden = !img.hidden;
    empty.textContent = banner ? "Image unavailable. Replace it to display your banner." : "No company image yet";
    if (banner && this.bannerImage) {
      img.src = banner.dataUrl;
      img.alt = `Banner preview: ${banner.name}`;
    } else img.removeAttribute("src");
    this.el("banner-upload-label").textContent = banner ? "Replace image" : "Choose an image";
    this.el<HTMLInputElement>("banner-visible").checked = !!banner?.visible;
    this.el<HTMLSelectElement>("banner-background").value = banner?.background ?? "light";
    this.el("banner-preview").classList.toggle("dark", banner?.background === "dark");
    for (const field of ["banner-anchor", "banner-visible", "banner-background", "banner-remove", "banner-view"])
      (this.el(field) as HTMLButtonElement).disabled =
        !banner || this.busy || (field === "banner-view" && (!banner.visible || !this.bannerImage));
    this.el("appearance-packages").replaceChildren(...this.prefs.packages.map((p) => this.packageRow(p)));
    this.el("installed").hidden = !this.installed;
    if (this.installed) {
      this.el("installed-note").textContent = this.installedRows.length
        ? `Loaded from ${this.installed.dir} when the page opens. Edit a file and reload the page; remove it to uninstall.`
        : `Put a package in ${this.installed.dir} and reload the page, or start kauak with --appearance <file>.`;
      this.el("installed-packages").replaceChildren(...this.installedRows.map((r) => this.installedRow(r)));
    }
    for (const field of ["appearance-theme", "appearance-characters", "banner-file", "package-file", "example-download"])
      (this.el(field) as HTMLInputElement).disabled = this.busy;
    if (showWarnings && this.startupWarnings.length) this.message(this.startupWarnings.join(" "), true);
  }
  private installedRow(r: { file: string; label: string; error: string | null }): HTMLLIElement {
    const row = document.createElement("li"),
      text = document.createElement("span"),
      file = document.createElement("small");
    text.textContent = r.error ? `${r.label} could not be loaded: ${r.error}` : r.label;
    if (r.error) text.className = "appearance-warning";
    file.textContent = r.file;
    file.title = r.file;
    row.append(text, file);
    return row;
  }
  /**
   * The example package as a file to save: the way to a first package of one's
   * own. A data URL, which there is no revoking before the browser has saved
   * it, on a link in the page, as some browsers click no other.
   */
  private downloadExample() {
    const a = document.createElement("a");
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(`${JSON.stringify(harbor, null, 2)}\n`)}`;
    a.download = "harbor.json";
    a.hidden = true;
    this.dialog.append(a);
    a.click();
    a.remove();
    this.message("harbor.json is downloading. Change its id, name and colors, then import it or install it.");
  }
  private packageRow(p: AppearancePackage): HTMLLIElement {
    const row = document.createElement("li"),
      text = document.createElement("span"),
      remove = document.createElement("button");
    const installed = this.installedIds.get(p.id);
    text.textContent = installed
      ? `${p.name} · ${p.version} is also installed on this machine, and the installed file is used. Remove this copy.`
      : `${p.name} · ${p.version}`;
    if (installed) {
      text.className = "appearance-warning";
      text.title = installed;
    }
    remove.textContent = "Remove";
    remove.className = "btn";
    remove.disabled = this.busy;
    remove.setAttribute("aria-label", `Remove ${p.name}`);
    remove.addEventListener("click", () => this.commit({ ...this.prefs, packages: this.prefs.packages.filter((v) => v.id !== p.id) }));
    row.append(text, remove);
    return row;
  }
  private async uploadBanner() {
    const input = this.el<HTMLInputElement>("banner-file"),
      file = input.files?.[0];
    if (!file || this.busy) return;
    this.busy = true;
    this.render(false);
    this.message("Preparing your image…");
    try {
      const b = await prepareBanner(file, this.el<HTMLSelectElement>("banner-anchor").value),
        image = await decodeImage(b.dataUrl);
      b.background = this.prefs.banner?.background ?? "light";
      const prev = this.bannerImage;
      this.bannerImage = image;
      if (!this.commit({ ...this.prefs, banner: b })) this.bannerImage = prev;
    } catch (e) {
      this.message((e as Error).message, true);
    } finally {
      this.busy = false;
      input.value = "";
      this.render(false);
    }
  }
  private async importPackage() {
    const input = this.el<HTMLInputElement>("package-file"),
      file = input.files?.[0];
    if (!file || this.busy) return;
    this.busy = true;
    this.render(false);
    try {
      if (file.size > MAX_PACKAGE_BYTES) throw new Error("Choose an appearance package smaller than 64 KB.");
      if (this.prefs.packages.length >= MAX_PACKAGES)
        throw new Error("Remove a custom appearance before adding another. This browser can keep up to eight.");
      const p = parsePackage(await file.text()),
        installed = this.installedIds.get(p.id);
      if (installed)
        throw new Error(
          `${p.id} is installed on this machine, from ${installed}. Give this package another id to import it, or edit that file.`,
        );
      // Validate against the current registry before persistence; startup recovery
      // skips broken packages, whereas an explicit import must show the error.
      this.registry.copy().register(p);
      this.commit({ ...this.prefs, packages: [...this.prefs.packages, p] });
    } catch (e) {
      this.message((e as Error).message, true);
    } finally {
      this.busy = false;
      input.value = "";
      this.render(false);
    }
  }
}
