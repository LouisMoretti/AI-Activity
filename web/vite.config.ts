import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "..");

// Dev: `npm run dev:web` serves the UI with HMR and proxies /api to the Node
// server (`npm run dev`, port 3000). Prod: `npm run build` → web/dist, which
// the Node server serves as its static root.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    // Live review through a Cloudflare quick tunnel.
    allowedHosts: [".trycloudflare.com"],
    proxy: { "/api": `http://localhost:${process.env.PORT || 3000}` },
    // The dev server may be exposed through the tunnel: only serve the web
    // sources, shared types and dependencies — never data/ (the SQLite DB)
    // or other repo files.
    fs: {
      strict: true,
      allow: [import.meta.dirname, path.join(repo, "shared"), path.join(repo, "node_modules")],
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
