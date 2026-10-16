#!/usr/bin/env node
// Launcher for scripts/replay/explain-week.ts: runs it with vite-node (the `@` alias only, via
// scripts/qa/vite.config.ts, which never reads the owner's .env.local) against the replay stack.
//   npm run replay:explain -- --out .replay/out/<dept>-<week> [--json <file>]
import { spawn } from "node:child_process";

import { REPLAY_API, ROOT } from "./lib.mjs";

const DEMO_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const child = spawn("npx", ["vite-node", "-c", "scripts/qa/vite.config.ts", "scripts/replay/explain-week.ts", "--", ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_SUPABASE_URL: REPLAY_API,
    VITE_SUPABASE_ANON_KEY: DEMO_ANON,
    VITE_VAPID_PUBLIC_KEY: "replay-placeholder",
    VITE_APP_URL: "http://localhost:8093",
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
