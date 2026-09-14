#!/usr/bin/env node
// npm run release — the one and only way carsiddur pushes a release tag
// (docs/RUNBOOK_ROLLBACK.md, docs/FREE_DEPLOYMENT.md §8, owner decisions
// 2026-09-14 #1/#2). Pushing the tag does NOT deploy the frontend: it
// triggers CI, and a human must click "Approve" on the `promote` job's
// `production` GitHub environment before the Worker rebuilds
// (.github/workflows/ci.yml). This script never touches Cloudflare or
// GitHub environment settings itself.
//
// Usage:
//   node scripts/release.mjs [--dry-run] [--yes-remote] [--yes]
//                             [--skip-check] [--status]
//
//   --dry-run      Print the plan (computed tag, pending migrations, edge
//                   functions that would deploy, …) and exit. Never runs a
//                   remote or destructive step — not even npm run check.
//   --yes-remote   Required to do anything that touches the hosted Supabase
//                   project or pushes the release tag (mirrors
//                   scripts/db-export.mjs's --linked guard). Without it (and
//                   without --dry-run) the script refuses, prints the plan,
//                   and exits 1 having touched nothing.
//   --yes          Skip the per-step y/N confirmation prompts. Never implied
//                   by --yes-remote; the two are independent.
//   --skip-check   Skip `npm run check` (discouraged — logs a warning).
//   --status       Print last tag, commits since, pending migrations (needs
//                   --yes-remote) and edge functions changed since the tag,
//                   then exit. Does not run the release steps.
//
// Steps (see docs/RUNBOOK_ROLLBACK.md for what each one means to roll back):
//   1. clean tree on main, up to date with origin/main
//   2. npm run check
//   3. functions:bundle freshness
//   4. backup (scripts/db-export.mjs --linked --yes-remote) + Google Drive reminder
//   5. supabase db push --dry-run, confirm, supabase db push (only if pending)
//   6. detect + deploy changed edge functions since the last release tag
//   7. create + push the vYYYY.MM.DD-n release tag
//   8. print what happens next + the post-release smoke checklist
//
// Never touches ../commucar-share.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TZ = "Asia/Jerusalem";
const EDGE_FUNCTIONS = ["push-dispatch", "answer-proposal", "on-ride-cancelled", "destination-route"];
const TAG_RE = /^v(\d{4})\.(\d{2})\.(\d{2})-(\d+)$/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", ...opts }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function run(command, args) {
  console.log(`\n$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function runCaptured(command, args) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8" });
}

/** YYYY.MM.DD in Asia/Jerusalem, no external deps (mirrors db-export.mjs's jerusalemTimestamp). */
function jerusalemDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}.${get("month")}.${get("day")}`;
}

function parseArgs(argv) {
  const args = { dryRun: false, yesRemote: false, yes: false, skipCheck: false, status: false };
  for (const a of argv) {
    switch (a) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes-remote":
        args.yesRemote = true;
        break;
      case "--yes":
        args.yes = true;
        break;
      case "--skip-check":
        args.skipCheck = true;
        break;
      case "--status":
        args.status = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        console.warn(`release: ignoring unknown argument "${a}"`);
    }
  }
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/release.mjs [--dry-run] [--yes-remote] [--yes] [--skip-check] [--status]

  --dry-run      Print the plan only; touches nothing remote or destructive.
  --yes-remote   Confirms this run may touch the hosted Supabase project and push the release tag.
  --yes          Skip y/N confirmation prompts (still requires --yes-remote for a real run).
  --skip-check   Skip 'npm run check' (discouraged).
  --status       Print last tag / commits since / pending migrations / changed functions, then exit.`);
}

async function confirm(question, { yes }) {
  if (yes) {
    console.log(`${question} (--yes) y`);
    return true;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Release tags
// ---------------------------------------------------------------------------

/** All `vYYYY.MM.DD-n` tags, sorted oldest -> newest. */
function releaseTags() {
  const raw = tryGit(["tag", "--list", "v*"]) ?? "";
  return raw
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => TAG_RE.test(t))
    .sort((a, b) => {
      const [, ya, ma, da, na] = TAG_RE.exec(a);
      const [, yb, mb, db, nb] = TAG_RE.exec(b);
      const da_ = `${ya}${ma}${da}`;
      const db_ = `${yb}${mb}${db}`;
      if (da_ !== db_) return da_ < db_ ? -1 : 1;
      return Number(na) - Number(nb);
    });
}

function lastTag() {
  const tags = releaseTags();
  return tags.length > 0 ? tags[tags.length - 1] : null;
}

function nextTagName(today, tags) {
  const suffixes = tags
    .map((t) => TAG_RE.exec(t))
    .filter((m) => `${m[1]}.${m[2]}.${m[3]}` === today)
    .map((m) => Number(m[4]));
  const next = suffixes.length > 0 ? Math.max(...suffixes) + 1 : 1;
  return `v${today}-${next}`;
}

// ---------------------------------------------------------------------------
// Edge functions changed since the last tag
// ---------------------------------------------------------------------------

function changedFunctionsSince(baseRef) {
  if (!baseRef) {
    return { functions: [...EDGE_FUNCTIONS], reason: "no previous release tag found — deploying all four" };
  }
  const diff = tryGit(["diff", "--name-only", `${baseRef}..HEAD`, "--", "supabase/functions"]);
  if (diff == null) {
    return { functions: [...EDGE_FUNCTIONS], reason: `could not diff against ${baseRef} — deploying all four` };
  }
  const files = diff.split("\n").filter(Boolean);
  if (files.length === 0) return { functions: [], reason: null };
  if (files.some((f) => f.startsWith("supabase/functions/_shared/"))) {
    return { functions: [...EDGE_FUNCTIONS], reason: "supabase/functions/_shared/** changed" };
  }
  const changed = EDGE_FUNCTIONS.filter((fn) => files.some((f) => f.startsWith(`supabase/functions/${fn}/`)));
  return { functions: changed, reason: null };
}

// ---------------------------------------------------------------------------
// Pending migrations (parsed from `supabase db push --dry-run` output)
// ---------------------------------------------------------------------------

function parsePendingMigrations(dryRunOutput) {
  const matches = dryRunOutput.match(/\b\d{14}_[A-Za-z0-9_]+\.sql\b/g) ?? [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Status mode
// ---------------------------------------------------------------------------

function printStatus(args) {
  const tag = lastTag();
  console.log(`Last release tag: ${tag ?? "(none yet)"}`);

  const commits = tag ? tryGit(["log", "--oneline", `${tag}..HEAD`]) : tryGit(["log", "--oneline"]);
  const commitLines = (commits ?? "").split("\n").filter(Boolean);
  console.log(`Commits since: ${commitLines.length}`);
  for (const line of commitLines.slice(0, 20)) console.log(`  ${line}`);
  if (commitLines.length > 20) console.log(`  … and ${commitLines.length - 20} more`);

  if (args.yesRemote) {
    console.log("\nPending migrations (npx supabase migration list --linked):");
    try {
      run("npx", ["supabase", "migration", "list", "--linked"]);
    } catch (err) {
      console.error(`  failed: ${err.message}`);
    }
  } else {
    console.log("\nPending migrations: pass --yes-remote to check against the hosted project.");
  }

  const { functions, reason } = changedFunctionsSince(tag);
  console.log(`\nEdge functions changed since ${tag ?? "(no tag)"}: ${functions.length > 0 ? functions.join(", ") : "none"}`);
  if (reason) console.log(`  (${reason})`);
}

// ---------------------------------------------------------------------------
// Dry-run plan (read-only; no step below this point may execute)
// ---------------------------------------------------------------------------

function printPlan(args = {}) {
  const branch = tryGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const status = tryGit(["status", "--porcelain"]) ?? "";
  const tag = lastTag();
  const today = jerusalemDate();
  const tagName = nextTagName(today, releaseTags());
  const { functions, reason } = changedFunctionsSince(tag);

  console.log("release --dry-run: plan only, nothing executed.\n");
  console.log(`Current branch: ${branch}`);
  console.log(`Working tree: ${status.trim() ? "NOT clean (would abort at step 1)" : "clean"}`);
  console.log(`Last release tag: ${tag ?? "(none yet)"}`);
  console.log(`Next release tag would be: ${tagName}`);
  console.log("\nSteps this would run for real (in order):");
  console.log("  1. Verify clean tree on main, up to date with origin/main");
  console.log("  2. npm run check" + (args.skipCheck ? " (skipped: --skip-check)" : ""));
  console.log("  3. npm run functions:bundle — verify supabase/functions/_shared/solver.js is fresh");
  console.log("  4. node scripts/db-export.mjs --linked --yes-remote — backup, then copy to Google Drive");
  console.log("  5. npx supabase db push --dry-run — push only if it lists pending migrations");
  console.log(
    `  6. Deploy edge functions changed since ${tag ?? "(no tag)"}: ` +
      (functions.length > 0 ? functions.join(", ") : "none") +
      (reason ? ` (${reason})` : ""),
  );
  console.log(`  7. Tag ${tagName}, annotated with the impact summary, and push it to origin`);
  console.log(
    "  8. Print next steps: the tag triggers CI; the owner approves the 'promote' job's " +
      "'production' environment in GitHub; production fast-forwards; Cloudflare builds the Worker.",
  );
  console.log("\nNothing above was executed. Re-run with --yes-remote (and without --dry-run) to do it for real.");
}

// ---------------------------------------------------------------------------
// Main (real run)
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    printPlan(args);
    return;
  }

  if (args.status) {
    printStatus(args);
    return;
  }

  if (!args.yesRemote) {
    console.error(
      "release refuses to run without --yes-remote: it would touch the hosted Supabase project and " +
        "push a release tag that triggers CI. Nothing has been touched. Re-run with --dry-run to see " +
        "the plan, or add --yes-remote to run for real.",
    );
    printPlan(args);
    process.exitCode = 1;
    return;
  }

  const completed = [];
  const remaining = [
    "1. clean tree on main, up to date with origin/main",
    "2. npm run check",
    "3. functions:bundle freshness",
    "4. backup (scripts/db-export.mjs --linked --yes-remote)",
    "5. supabase db push",
    "6. deploy changed edge functions",
    "7. create + push the release tag",
    "8. print what happens next",
  ];

  function fail(message) {
    console.error(`\nrelease: FAILED — ${message}`);
    console.error(`Completed: ${completed.join(", ") || "(nothing)"}`);
    console.error(`Remaining steps: \n  ${remaining.join("\n  ")}`);
    process.exitCode = 1;
  }

  function stepDone(label) {
    completed.push(label);
    remaining.shift();
  }

  // Step 1 — clean tree, on main, up to date with origin/main.
  console.log("\n=== Step 1/8: preflight ===");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") return fail(`must be on 'main', currently on '${branch}'.`);
  const status = git(["status", "--porcelain"]);
  if (status.trim()) return fail("working tree is not clean — commit or stash first.");
  try {
    run("git", ["fetch", "origin", "main"]);
  } catch (err) {
    return fail(`git fetch origin main failed: ${err.message}`);
  }
  const localSha = git(["rev-parse", "HEAD"]);
  const remoteSha = git(["rev-parse", "origin/main"]);
  if (localSha !== remoteSha) {
    return fail(
      `local main (${localSha.slice(0, 8)}) is not the same commit as origin/main (${remoteSha.slice(0, 8)}) — pull or push first.`,
    );
  }
  console.log("OK: clean, on main, matches origin/main.");
  stepDone("preflight");

  // Step 2 — npm run check.
  console.log("\n=== Step 2/8: npm run check ===");
  if (args.skipCheck) {
    console.warn("SKIPPED (--skip-check) — discouraged, releasing without lint/typecheck/unit tests.");
  } else {
    try {
      run("npm", ["run", "check"]);
    } catch (err) {
      return fail(`npm run check failed: ${err.message}`);
    }
  }
  stepDone("check");

  // Step 3 — solver bundle freshness.
  console.log("\n=== Step 3/8: functions bundle freshness ===");
  try {
    run("npm", ["run", "functions:bundle"]);
    run("git", ["diff", "--exit-code", "--", "supabase/functions/_shared/solver.js"]);
  } catch (err) {
    return fail(
      "supabase/functions/_shared/solver.js was stale and just changed on disk — commit the regenerated " +
        `bundle and re-run. (${err.message})`,
    );
  }
  console.log("OK: solver bundle is fresh.");
  stepDone("bundle-freshness");

  // Step 4 — backup.
  console.log("\n=== Step 4/8: database backup ===");
  if (!(await confirm("Run scripts/db-export.mjs --linked --yes-remote against the hosted project now?", args))) {
    return fail("aborted at the backup confirmation.");
  }
  try {
    run("node", ["scripts/db-export.mjs", "--linked", "--yes-remote"]);
  } catch (err) {
    return fail(`db-export failed: ${err.message}`);
  }
  console.log(
    "\nIMPORTANT: copy the three backups/*.sql files just written to Google Drive now (owner decision " +
      "2026-09-14 #3: pre-release dump + weekly, keep ~8). This script does not upload them for you.",
  );
  stepDone("backup");

  // Step 5 — migrations.
  console.log("\n=== Step 5/8: database migrations ===");
  let dryRunOutput;
  try {
    dryRunOutput = runCaptured("npx", ["supabase", "db", "push", "--dry-run", "--linked"]);
    console.log(dryRunOutput);
  } catch (err) {
    return fail(`supabase db push --dry-run failed: ${err.stdout ?? err.message}`);
  }
  const pending = parsePendingMigrations(dryRunOutput);
  if (pending.length === 0) {
    console.log("No pending migrations — skipping push.");
  } else {
    console.log(`Pending migrations (${pending.length}): ${pending.join(", ")}`);
    if (!(await confirm(`Push these ${pending.length} migration(s) to the hosted project?`, args))) {
      return fail("aborted at the migration-push confirmation.");
    }
    try {
      run("npx", ["supabase", "db", "push", "--linked"]);
    } catch (err) {
      return fail(`supabase db push failed: ${err.message}`);
    }
  }
  stepDone("migrations");

  // Step 6 — edge functions.
  console.log("\n=== Step 6/8: edge functions ===");
  const priorTag = lastTag();
  const { functions: changedFns, reason } = changedFunctionsSince(priorTag);
  if (reason) console.log(`Note: ${reason}`);
  if (changedFns.length === 0) {
    console.log("No edge function changes to deploy.");
  } else {
    console.log(`Functions to deploy: ${changedFns.join(", ")}`);
    if (!(await confirm(`Deploy ${changedFns.join(", ")} to the hosted project?`, args))) {
      return fail("aborted at the edge-function deploy confirmation.");
    }
    for (const fn of changedFns) {
      try {
        run("npx", ["supabase", "functions", "deploy", fn]);
      } catch (err) {
        return fail(`deploying ${fn} failed: ${err.message}`);
      }
    }
  }
  stepDone("functions");

  // Step 7 — tag.
  console.log("\n=== Step 7/8: release tag ===");
  const today = jerusalemDate();
  const tagName = nextTagName(today, releaseTags());
  let impactSummary = null;
  if (priorTag && fs.existsSync(path.join(ROOT, "scripts", "impact.mjs"))) {
    try {
      impactSummary = runCaptured("node", ["scripts/impact.mjs", priorTag]);
    } catch {
      impactSummary = null;
    }
  }
  const commitList = (priorTag ? tryGit(["log", "--format=- %s", `${priorTag}..HEAD`]) : tryGit(["log", "--format=- %s", "-20"])) ?? "";
  const message = [
    `Release ${tagName}`,
    "",
    "Commits:",
    commitList,
    ...(impactSummary ? ["", "Impact analysis:", impactSummary] : []),
  ].join("\n");

  if (!(await confirm(`Create and push annotated tag ${tagName}? This triggers CI (not the frontend deploy).`, args))) {
    return fail("aborted at the tag confirmation.");
  }
  try {
    fs.writeFileSync(path.join(ROOT, ".release-tag-message.tmp"), message, "utf8");
    run("git", ["tag", "-a", tagName, "-F", ".release-tag-message.tmp"]);
    fs.rmSync(path.join(ROOT, ".release-tag-message.tmp"));
    run("git", ["push", "origin", tagName]);
  } catch (err) {
    return fail(`tagging/pushing failed: ${err.message}`);
  }
  stepDone("tag");

  // Step 8 — what happens next.
  console.log("\n=== Step 8/8: what happens next ===");
  console.log(`
Tag ${tagName} is pushed. From here:
  1. CI runs 'check' + 'database' on the tag; if both pass, 'promote' waits for approval.
  2. The owner opens the GitHub Actions run and clicks "Approve" on the 'production' environment.
     THIS CLICK is the one and only "deploy frontend" action — nothing goes live before it.
  3. Approval fast-forwards the 'production' branch to this tag; Cloudflare rebuilds the 'carsiddur' Worker.

Post-release smoke checklist (docs/RUNBOOK_ROLLBACK.md):
  - Sign in; siddur, board and stats pages load.
  - Version footer on /profile shows ${tagName}.
  - Supabase Edge Function logs are clean.
  - 'npx supabase migration list --linked' matches what was just pushed.
`);
  stepDone("done");
}

main().catch((err) => {
  console.error(`release: unexpected error — ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
