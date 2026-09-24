import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Dev: `npm run dev:web` serves the UI with HMR and proxies /api to the Node
// server (`npm run dev`, port 3000). Prod: `npm run build` → web/dist, which
// the Node server serves as its static root.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  server: {
    proxy: { "/api": `http://localhost:${process.env.PORT || 3000}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
