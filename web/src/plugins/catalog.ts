import classic from "../../../plugins/classic.json";
import orbital from "../../../plugins/orbital.json";
import basecamp from "../../../plugins/basecamp.json";
import herdr from "../../../plugins/herdr.json";
import { PluginRegistry } from "../../../shared/plugins/registry";

/** Add bundled data packages here; the scene never imports individual packages. */
export const bundledPackages = [classic, orbital, basecamp, herdr];
const included = new PluginRegistry(bundledPackages);
export const defaultTheme = included.resolve("office.theme", "agent-office.classic").plugin.capabilities["office.theme"]!;
export const defaultCharacters = included.resolve("office.characters", "agent-office.classic").plugin.capabilities["office.characters"]!;
