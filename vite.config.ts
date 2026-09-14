import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// In-app version footer (docs/RUNBOOK_ROLLBACK.md, CLAUDE.md release tooling,
// owner decision 2026-09-14 #5): baked in at build time so the profile screen
// can show which release tag/commit is actually live. Prefers a real git
// describe (works for a full local/CI checkout with tags); Cloudflare's Git
// integration does a shallow clone with no tags, so it falls back to the
// commit SHA Cloudflare exposes as a build env var, and finally "dev" for a
// plain local `npm run dev`/build with neither available.
function appVersion(): string {
  try {
    return execSync("git describe --tags --always --dirty", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    const sha = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
    return sha ? sha.slice(0, 8) : "dev";
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    host: true,
    port: 8080,
  },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: "auto",
      registerType: "autoUpdate",
      devOptions: {
        enabled: false,
      },
      manifest: {
        name: "סידור רכב נבו",
        short_name: "סידור רכב",
        description: "אפליקציית סידור הרכב השבועי של קיבוץ נבו",
        dir: "rtl",
        lang: "he",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f172a",
        icons: [
          {
            src: "/icons/icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/icon-maskable.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
