import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react-swc";
import { defineConfig } from "vitest/config";

// Unit tests only (ARCHITECTURE.md §14): src/solver, src/solver/rules,
// src/lib. Component tests (*.test.tsx) run under jsdom with jest-dom
// matchers; plain *.test.ts (solver, lib, time math) run under node, which
// is faster and closer to how the edge functions execute.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: false,
    environment: "node",
    environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    // Playwright specs live under e2e/ and are run by `npm run test:e2e`,
    // not Vitest. supabase/tests/*.test.mjs are plain-Node smoke tests run
    // by `npm run functions:bundle` (assert-based, no describe/it) — Vitest's
    // default glob otherwise picks them up and fails with "no test suite".
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "supabase/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
