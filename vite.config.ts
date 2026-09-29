import { defineConfig } from "vite";

export default defineConfig(({ mode }) => ({
  root: "web",
  // The demo build (`--mode demo`) is a static site that may live under a subpath (GitHub Pages).
  base: mode === "demo" ? "./" : "/",
  server: { port: 5178, open: false },
  build: { outDir: mode === "demo" ? "../dist-demo" : "../dist", emptyOutDir: true },
}));
