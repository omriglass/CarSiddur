// Minimal Vite config for `vite-node` (qa:sadran / qa:member): only the `@` alias, no React/PWA
// plugins, and an `envDir` that holds no .env files so the owner's `.env.local` (54321) is never read.
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";

export default defineConfig({
  envDir: fileURLToPath(new URL("./", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
});
