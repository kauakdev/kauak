import { defineConfig } from "vite";
import { thirdPartyLicenses } from "../../scripts/third-party-licenses.js";

export default defineConfig(({ mode }) => ({
  // The demo build (`--mode demo`) is a static site that may live under a subpath (GitHub Pages).
  base: mode === "demo" ? "./" : "/",
  server: { port: 5178, open: false },
  // The page goes into the npm package (packages/kauak), the demo to the repository root for GitHub Pages.
  build: { outDir: mode === "demo" ? "../../dist-demo" : "../kauak/dist", emptyOutDir: true },
  plugins: [thirdPartyLicenses()],
}));
