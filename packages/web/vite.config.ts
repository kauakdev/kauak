import { defineConfig, loadEnv } from "vite";
import { thirdPartyLicenses } from "../../scripts/third-party-licenses.js";

export default defineConfig(({ mode }) => ({
  // The demo build (`--mode demo`) is a static site that may live under a subpath (GitHub Pages).
  base: mode === "demo" ? "./" : "/",
  server: {
    port: 5178,
    open: false,
    // The appearance packages installed on this machine come from the bridge, which `pnpm dev` runs beside Vite,
    // on the port the page's WebSocket goes to: VITE_BRIDGE_PORT from the environment or a .env file, as the page reads it.
    proxy: { "/appearances.json": `http://127.0.0.1:${loadEnv(mode, process.cwd(), "VITE_").VITE_BRIDGE_PORT || 7788}` },
  },
  // The page goes into the npm package (packages/kauak), the demo to the repository root for GitHub Pages.
  build: { outDir: mode === "demo" ? "../../dist-demo" : "../kauak/dist", emptyOutDir: true },
  plugins: [thirdPartyLicenses()],
}));
