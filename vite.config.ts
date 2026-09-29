import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  server: { port: 5178, open: false },
  build: { outDir: "../dist", emptyOutDir: true },
});
