import classic from "@kauak/appearance/packages/classic.json";
import orbital from "@kauak/appearance/packages/orbital.json";
import basecamp from "@kauak/appearance/packages/basecamp.json";
import { AppearanceRegistry } from "@kauak/appearance/registry";

/** Add bundled data packages here; the scene never imports individual packages. */
export const bundledPackages = [classic, orbital, basecamp];
const included = new AppearanceRegistry(bundledPackages);
export const defaultTheme = included.resolve("office.theme", "kauak.classic").package.capabilities["office.theme"]!;
export const defaultCharacters = included.resolve("office.characters", "kauak.classic").package.capabilities["office.characters"]!;
