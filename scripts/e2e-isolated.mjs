#!/usr/bin/env node
// Code review 2026-09-24 R5 (docs/TODO.md): `npm run test:e2e` serves the live working
// tree through Vite, and every db reset (global-setup, board.spec.ts's afterAll) replays
// whatever migrations are on disk at that moment — so an edit made while the suite runs
// (another agent, the owner) breaks page loads mid-run or applies a half-written migration.
//
// This runner freezes the code first:
//   - default: a snapshot of the working tree as it is now (tracked + untracked files,
//     gitignored ones excluded), so uncommitted work is tested but later edits are not;
//   - --head: `git archive HEAD` only (committed code, ignores the working tree).
// The snapshot gets a symlink to node_modules and copies of the local env files, runs Vite
// on its own port (default 8091, override with E2E_ISOLATED_PORT), and points
// E2E_SUPABASE_WORKDIR at itself so every reset replays the snapshot's migrations.
// It still uses the one local Supabase stack — the database is reset exactly as by
// `npm run test:e2e`.
//
// Usage:
//   npm run e2e:isolated -- [--head] [--keep] [playwright args...]
//   e.g. npm run e2e:isolated -- --head e2e/member.spec.ts --retries=0
//
// --keep leaves the snapshot directory in place (its path is printed) for trace inspection.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const head = args.includes("--head");
const keep = args.includes("--keep");
const playwrightArgs = args.filter((a) => a !== "--head" && a !== "--keep");
const port = process.env.E2E_ISOLATED_PORT ?? "8091";

const snapshot = mkdtempSync(join(tmpdir(), "carshare-e2e-"));
console.log(`[e2e:isolated] snapshot (${head ? "HEAD" : "working tree"}) → ${snapshot}`);

if (head) {
  const archive = execFileSync("git", ["archive", "HEAD"], { cwd: root, maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", snapshot], { input: archive });
} else {
  const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: root })
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const from = join(root, file);
    if (!existsSync(from)) continue; // deleted but not yet staged
    const to = join(snapshot, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
  }
}

symlinkSync(join(root, "node_modules"), join(snapshot, "node_modules"));
// Gitignored local env files the dev server and edge functions need.
for (const envFile of [".env.local", ".env", "supabase/functions/.env"]) {
  const from = join(root, envFile);
  if (existsSync(from)) cpSync(from, join(snapshot, envFile));
}

const result = spawnSync("npx", ["playwright", "test", ...playwrightArgs], {
  cwd: snapshot,
  stdio: "inherit",
  env: {
    ...process.env,
    E2E_BASE_URL: `http://localhost:${port}`,
    E2E_SUPABASE_WORKDIR: snapshot,
  },
});

// Playwright's webServer may have started `supabase functions serve` from the snapshot
// (playwright.config.ts, when the edge functions were not answering yet). That replaces the
// local stack's edge-runtime container with one bind-mounted on `<snapshot>/supabase/functions`;
// once the snapshot is deleted every function call fails with "failed to determine entrypoint"
// (found 2026-10-05: answering a proposal showed "לא ניתן לטעון את ההצעה כרגע" for days).
// Restart the stack from the repository so the container mounts the real functions again —
// `supabase stop` keeps the database volume, so this resets nothing beyond what the run did.
function edgeRuntimeMountsSnapshot() {
  try {
    const config = readFileSync(join(root, "supabase", "config.toml"), "utf8");
    const projectId = /^project_id\s*=\s*"([^"]+)"/m.exec(config)?.[1];
    if (!projectId) return false;
    const mounts = execFileSync("docker", ["inspect", `supabase_edge_runtime_${projectId}`, "--format", "{{range .Mounts}}{{.Source}}\n{{end}}"], { encoding: "utf8" });
    return mounts.split("\n").some((source) => source.includes(snapshot));
  } catch {
    return false; // no docker / no edge runtime container: nothing to repair
  }
}
if (!keep && edgeRuntimeMountsSnapshot()) {
  console.log("[e2e:isolated] the edge runtime is mounted on the snapshot — restarting the local stack from the repository");
  spawnSync("npx", ["supabase", "stop"], { cwd: root, stdio: "inherit" });
  spawnSync("npx", ["supabase", "start"], { cwd: root, stdio: "inherit" });
}

if (keep) console.log(`[e2e:isolated] kept ${snapshot}`);
else rmSync(snapshot, { recursive: true, force: true });
process.exit(result.status ?? 1);
