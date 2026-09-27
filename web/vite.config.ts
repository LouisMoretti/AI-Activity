import path from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig, loadEnv } from "vite";

const repo = path.resolve(import.meta.dirname, "..");

// Extra host names for live review behind your own reverse proxy (the repo's
// .env or the environment, comma-separated): the dev server then listens on
// every interface instead of localhost only.
const devHosts = (process.env.DEV_HOSTS ?? loadEnv("development", repo, "DEV_").DEV_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

// Dev: `npm run dev:web` serves the UI with HMR and proxies /api to the Node
// server (`npm run dev`, port 3000). Prod: `npm run build` → web/dist, which
// the Node server serves as its static root.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [svelte()],
  server: {
    port: 5173,
    strictPort: true,
    host: devHosts.length > 0 ? true : "localhost",
    // Live review through a Cloudflare quick tunnel, or DEV_HOSTS.
    allowedHosts: [".trycloudflare.com", ...devHosts],
    // The install scripts too: the Devices panel's commands fetch them from
    // this origin, and the SPA fallback would hand `sh` the page's HTML.
    proxy: Object.fromEntries(
      ["/api", "/install.sh", "/install.ps1"].map((p) => [p, `http://localhost:${process.env.PORT || 3000}`]),
    ),
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
