import { defineConfig } from "vite";
export default defineConfig({
  root: "ui",
  build: { outDir: "../dist/ui", emptyOutDir: false },
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
});
