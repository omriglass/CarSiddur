#!/usr/bin/env node
// Launcher for the QA CLIs (`npm run qa:sadran -- ...`, `qa:member`). Points the app's own
// modules (src/lib/env.ts -> supabase client) at the DISPOSABLE stack and refuses the owner's
// stack (port 54321) before anything runs. Usage: node scripts/qa/run.mjs <sadran|member> [args]
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertDisposable, qaEnv } from "./lib/stack.mjs";

const [tool, ...rest] = process.argv.slice(2);
if (tool !== "sadran" && tool !== "member") {
  console.error("usage: run.mjs <sadran|member> <command> [args]");
  process.exit(2);
}
const env = qaEnv();
assertDisposable(env.VITE_SUPABASE_URL);
const root = fileURLToPath(new URL("../../", import.meta.url));
const child = spawn(
  "npx",
  ["vite-node", "-c", "scripts/qa/vite.config.ts", `scripts/qa/${tool}.ts`, "--", ...rest],
  { cwd: root, stdio: "inherit", env: { ...process.env, ...env } },
);
child.on("exit", (code) => process.exit(code ?? 1));
