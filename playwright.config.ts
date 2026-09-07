import { defineConfig, devices } from "@playwright/test";

// Allow a disposable Supabase/Vite stack without disturbing the developer's data.
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:8080";
const appPort = new URL(baseURL).port || "8080";
const apiURL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";

// ARCHITECTURE.md §14: runs against the local Supabase stack + dev server.
// `npm run db:start` must be running separately; this config starts the Vite
// dev server and the local Edge Functions server (Stage 3 hardening,
// docs/UX_FLOWS.md §16 item 6 — e2e/proposal.spec.ts and e2e/freed-slot.spec.ts
// exercise `answer-proposal`/`on-ride-cancelled`). Both entries use
// `reuseExistingServer: true` unconditionally (not just outside CI): the
// local Supabase stack's own `supabase_edge_runtime_<project>` container
// already serves the same functions on the same port as soon as `supabase
// start` is up, so `npm run functions:serve` is typically a no-op reuse, not
// a second server — see supabase/functions/README.md.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // Stage 3 hardening: forced to 1. Every spec shares the one seeded department/week dataset
  // (supabase/seed.sql — there is exactly one Open week, one Live week), so specs that mutate
  // shared rows there (member.spec.ts submitting into the Open week; sadran.spec.ts solving/
  // publishing it) race under real parallel workers. This was previously silent — running
  // workers concurrently just happened not to collide — until `apply_solver_result`'s new
  // staleness check (20260907092600_apply_solver_result_staleness.sql, DATA_MODEL.md §6.1 item
  // 17) started *correctly* detecting the resulting concurrent modification as `stale_input`,
  // reproduced by running the full suite repeatedly: sadran.spec.ts's first test failed
  // intermittently only under `workers > 1`, never alone. The suite is fast enough serial
  // (well under two minutes) that trading worker parallelism for determinism is the right call
  // here, rather than chasing narrower per-file isolation.
  workers: 1,
  // Resets the local database to the seed before the run (see e2e/global-setup.ts).
  globalSetup: "./e2e/global-setup.ts",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  // First navigation after a db reset can take >30 s while Vite cold-compiles
  // and the Supabase containers settle; 60 s keeps that from reading as a failure.
  timeout: 60_000,
  reporter: "html",
  use: {
    baseURL,
    navigationTimeout: 45_000,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `npm run dev -- --port ${appPort} --strictPort`,
      url: baseURL,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "npm run functions:serve",
      url: `${apiURL}/functions/v1/answer-proposal`,
      reuseExistingServer: true,
    },
  ],
});
