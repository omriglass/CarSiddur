#!/usr/bin/env node
// scripts/replay/stack.mjs — the dedicated local stack for week replays.
//
// A copy of supabase/ under .replay/stack (gitignored) with its own project id
// (`carshare-replay`) and ports (API 56321, DB 56322), so a replay never touches
// the owner's stack (54321) or another session's disposable stack. Only db, auth,
// rest and kong run (the rest is excluded), which is all the app needs to solve.
//
//   node scripts/replay/stack.mjs start    copy migrations/seed, start (or migrate) the stack
//   node scripts/replay/stack.mjs stop     stop it (data is kept by Docker volumes)
//   node scripts/replay/stack.mjs status
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REPLAY_API, REPLAY_DB_CONTAINER, REPLAY_PROJECT_ID, ROOT } from "./lib.mjs";

const WORKDIR = path.join(ROOT, ".replay", "stack");
const EXCLUDED = "studio,realtime,storage-api,imgproxy,logflare,vector,edge-runtime,mailpit,postgres-meta,supavisor";

function run(args, opts = {}) {
  const res = spawnSync("npx", ["supabase", ...args, "--workdir", WORKDIR], { cwd: ROOT, stdio: "inherit", ...opts });
  return res.status ?? 1;
}

/** Fresh copy of supabase/ (migrations, seed, config) with the replay project id and ports. */
function syncWorkdir() {
  const target = path.join(WORKDIR, "supabase");
  mkdirSync(WORKDIR, { recursive: true });
  rmSync(path.join(target, "migrations"), { recursive: true, force: true });
  cpSync(path.join(ROOT, "supabase"), target, {
    recursive: true,
    filter: (src) => !/[\\/]supabase[\\/](\.temp|\.branches)([\\/]|$)/.test(src),
  });
  const configPath = path.join(target, "config.toml");
  const config = readFileSync(configPath, "utf8")
    .replace(/^project_id = ".*"$/m, `project_id = "${REPLAY_PROJECT_ID}"`)
    .replace(/^(\s*(?:port|shadow_port|smtp_port|pop3_port)\s*=\s*)543(\d\d)/gm, "$1563$2")
    .replace(/^(\s*inspector_port\s*=\s*)8083/m, "$18183");
  writeFileSync(configPath, config);
}

function isRunning() {
  const res = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  return (res.stdout ?? "").split("\n").includes(REPLAY_DB_CONTAINER);
}

const cmd = process.argv[2];
if (cmd === "start") {
  syncWorkdir();
  if (isRunning()) {
    console.log(`replay stack: running — applying any new migrations`);
    process.exit(run(["migration", "up", "--local"]));
  }
  process.exit(run(["start", "-x", EXCLUDED]));
} else if (cmd === "stop") {
  if (!existsSync(WORKDIR)) { console.log("replay stack: not set up"); process.exit(0); }
  process.exit(run(["stop"]));
} else if (cmd === "status") {
  console.log(isRunning() ? `replay stack: running (${REPLAY_API}, container ${REPLAY_DB_CONTAINER})` : "replay stack: not running");
} else {
  console.error("usage: node scripts/replay/stack.mjs <start|stop|status>");
  process.exit(2);
}
