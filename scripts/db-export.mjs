#!/usr/bin/env node
// Database export for manual/scheduled backups (Supabase Free has no automatic
// backups — see docs/FREE_DEPLOYMENT.md §8). Writes a schema dump, a data-only
// dump and a roles dump to a timestamped set of files under backups/ (or --out).
//
// Restore against an *empty* project:
//   psql "$DB_URL" -f backups/schema-<ts>.sql
//   psql "$DB_URL" -f backups/data-<ts>.sql
// (roles-<ts>.sql is only needed when restoring into a fresh cluster that does
// not already have the expected Postgres roles.)
//
// These dumps contain member PII (full names, phone numbers). Never commit the
// output directory (backups/ is in .gitignore) and never paste dump contents
// into chat, issues or logs.
//
// Usage:
//   node scripts/db-export.mjs [--local|--linked] [--out <dir>] [--yes-remote]
//
// Defaults to --local (safe, no confirmation needed). --linked targets the
// linked hosted project and refuses to run unless --yes-remote is also passed
// (mirrors fake-week.mjs's --allow-remote guard) — otherwise it prints what it
// would do and exits 1 without touching anything.
//
// Never touches ../commucar-share.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

const SCHEMAS = "public,app";

function printUsage() {
  console.log(`Usage: node scripts/db-export.mjs [--local|--linked] [--out <dir>] [--yes-remote]

  --local        Dump the local Supabase stack (default).
  --linked       Dump the linked hosted project. Requires --yes-remote.
  --yes-remote   Confirms a --linked export is intentional.
  --out <dir>    Output directory (default: backups/ at the repo root).
  --help, -h     Show this help.

Writes schema-<ts>.sql, data-<ts>.sql and roles-<ts>.sql (Asia/Jerusalem
timestamp) to the output directory. Contains member PII — keep it out of git
and out of chat.`);
}

function parseArgs(argv) {
  const args = { target: "local", out: null, yesRemote: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--local":
        args.target = "local";
        break;
      case "--linked":
        args.target = "linked";
        break;
      case "--yes-remote":
        args.yesRemote = true;
        break;
      case "--out":
        args.out = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.warn(`db-export: ignoring unknown argument "${a}"`);
    }
  }
  return args;
}

// YYYY-MM-DD_HHmm in Asia/Jerusalem, no external deps.
function jerusalemTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}${get("minute")}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function dump(target, extraFlags, file) {
  const flags = [`--${target}`, "-f", file, ...extraFlags];
  console.log(`Running: npx supabase db dump ${flags.join(" ")}`);
  execFileSync("npx", ["supabase", "db", "dump", ...flags], { stdio: "inherit" });
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.target === "linked" && !args.yesRemote) {
    console.error(
      `db-export refuses to run against the linked (hosted) project without --yes-remote.\n` +
        `Would run:\n` +
        `  npx supabase db dump --linked --schema ${SCHEMAS} -f <out>/schema-<ts>.sql\n` +
        `  npx supabase db dump --linked --schema ${SCHEMAS} --data-only --use-copy -f <out>/data-<ts>.sql\n` +
        `  npx supabase db dump --linked --role-only -f <out>/roles-<ts>.sql\n` +
        `Pass --yes-remote to confirm you intend to export the hosted project.`,
    );
    process.exitCode = 1;
    return;
  }

  const outDir = path.resolve(args.out ?? "backups");
  mkdirSync(outDir, { recursive: true });

  const ts = jerusalemTimestamp();
  const files = {
    schema: path.join(outDir, `schema-${ts}.sql`),
    data: path.join(outDir, `data-${ts}.sql`),
    roles: path.join(outDir, `roles-${ts}.sql`),
  };

  dump(args.target, ["--schema", SCHEMAS], files.schema);
  dump(args.target, ["--schema", SCHEMAS, "--data-only", "--use-copy"], files.data);
  dump(args.target, ["--role-only"], files.roles);

  console.log("\nWrote:");
  for (const file of Object.values(files)) {
    if (!existsSync(file)) {
      throw new Error(`expected output file missing: ${file}`);
    }
    console.log(`  ${file} (${formatBytes(statSync(file).size)})`);
  }
}

try {
  main();
} catch (err) {
  console.error(`db-export: ${err.message}`);
  process.exitCode = 1;
}
