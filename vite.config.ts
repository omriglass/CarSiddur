import { execSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// In-app version footer (docs/RUNBOOK_ROLLBACK.md, CLAUDE.md release tooling,
// owner decisions 2026-09-14 #5 and 2026-10-10): baked in at build time so the
// profile screen shows which release is live — "<tag> · <commit>" when the
// commit carries a release tag, else just the commit. Cloudflare's Git
// integration builds a shallow clone with no tags (so `git describe` alone can
// only give the commit): the tag is then looked up on the remote with
// `git ls-remote --tags`, which needs no history. Every step is best effort —
// any failure falls back to the commit, and finally "dev".
function git(args: string): string {
  return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"], timeout: 8000 }).toString().trim();
}

/** Owner alias tags (e.g. v1.2) win over the automatic vYYYY.MM.DD-n tag on the same commit, like `git describe`. */
function pickTag(tags: string[]): string | null {
  const automatic = /^v\d{4}\.\d{2}\.\d{2}-\d+$/;
  const sorted = [...new Set(tags)].sort().reverse();
  return sorted.find((tag) => !automatic.test(tag)) ?? sorted[0] ?? null;
}

function releaseTag(fullSha: string): string | null {
  try {
    const local = git(`tag --points-at ${fullSha}`).split("\n").filter(Boolean);
    if (local.length) return pickTag(local);
  } catch { /* no local tags */ }
  try {
    // Only a shallow clone (Cloudflare) lacks tags it should have; a full checkout already answered above.
    if (git("rev-parse --is-shallow-repository") !== "true") return null;
    // "<sha>\trefs/tags/<name>" lines; annotated tags also list the peeled commit as "<name>^{}".
    const remote = git("ls-remote --tags origin")
      .split("\n")
      .map((line) => line.split("\t"))
      .filter(([sha, ref]) => sha === fullSha && ref?.startsWith("refs/tags/"))
      .map(([, ref]) => (ref ?? "").replace(/^refs\/tags\//, "").replace(/\^\{\}$/, ""));
    return pickTag(remote);
  } catch {
    return null;
  }
}

function appVersion(): string {
  let fullSha: string | undefined;
  let dirty = false;
  try {
    fullSha = git("rev-parse HEAD");
    dirty = git("status --porcelain --untracked-files=no") !== "";
  } catch {
    fullSha = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA;
  }
  if (!fullSha) return "dev";
  const commit = `${fullSha.slice(0, 8)}${dirty ? "-dirty" : ""}`;
  const tag = releaseTag(fullSha);
  return tag ? `${tag} · ${commit}` : commit;
}

// https://vitejs.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    rollupOptions: {
      output: {
        // Vendor split (owner, 2026-09-14: the single 1.3 MB index chunk tripped Vite's
        // 500 kB warning on every build). Stable, rarely-changing libraries get their own
        // long-cacheable chunks; app code stays in the route chunks the lazy routes create.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("/@supabase/")) return "vendor-supabase";
          if (id.includes("/@tanstack/")) return "vendor-query";
          if (id.includes("/@radix-ui/")) return "vendor-radix";
          if (id.includes("/lucide-react/")) return "vendor-icons";
          if (/[\\/]node_modules[\\/](date-fns|date-fns-tz)[\\/]/.test(id)) return "vendor-date";
          if (/[\\/]node_modules[\\/](react-hook-form|@hookform|zod)[\\/]/.test(id)) return "vendor-forms";
          return "vendor";
        },
      },
    },
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
