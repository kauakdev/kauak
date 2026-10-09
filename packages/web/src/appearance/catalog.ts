import classic from "@kauak/appearance/packages/classic.json";
import orbital from "@kauak/appearance/packages/orbital.json";
import basecamp from "@kauak/appearance/packages/basecamp.json";
import herdr from "@kauak/appearance/packages/herdr.json";
import { PluginRegistry } from "@kauak/appearance/registry";

/** Add bundled data packages here; the scene never imports individual packages. */
export const bundledPackages = [classic, orbital, basecamp, herdr];
const included = new PluginRegistry(bundledPackages);
export const defaultTheme = included.resolve("office.theme", "agent-office.classic").plugin.capabilities["office.theme"]!;
export const defaultCharacters = included.resolve("office.characters", "agent-office.classic").plugin.capabilities["office.characters"]!;
