#!/usr/bin/env node
// npm run release step B / CI `check` job guard (docs/RUNBOOK_ROLLBACK.md,
// supabase/rollback/README.md): every NEW migration added since <base-ref>
// is scanned for statements that would break a running frontend if applied
// without a tested down script — CLAUDE.md's forward-fix rule (owner
// decision 2026-09-14 #4: additive/expand-contract, never drop/rename a
// column the running frontend still uses in the same release).
//
// Usage:
//   node scripts/check-migrations.mjs <base-ref>
//
// For each migration file added in `<base-ref>...HEAD` under
// supabase/migrations/, flags statements matching (case-insensitive):
//   drop table | drop column | alter table ... drop | rename column |
//   rename to | alter type ... rename | drop function | drop policy | drop trigger
// unless a matching supabase/rollback/<same timestamp>_down.sql exists.
//
// Two narrow exceptions (both common, non-destructive idioms):
//   - `drop function if exists <fn>` immediately followed by
//     `create or replace function <same fn>` — a signature replacement, not
//     a real drop.
//   - `drop policy`/`drop trigger` followed later in the same file by a
//     `create [or replace] policy|trigger` of the same name — the
//     drop-then-recreate idiom used throughout this repo's migrations.
//
// Exit 0: clean (or no new migrations). Exit 2: at least one unguarded
// destructive statement. Exit 1: usage/git error.
//
// This is a heuristic statement scanner, not a SQL parser — it is
// deliberately conservative (see splitStatements) and meant to catch the
// common cases, not replace human review of a migration.
//
// Never touches ../commucar-share.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Statement splitting — dollar-quote and string-literal aware, so a `;`
// inside a PL/pgSQL function body or a string literal does not end the
// statement early. Comments on their own line are stripped first.
// ---------------------------------------------------------------------------

export function stripLineComments(sql) {
  return sql
    .split("\n")
    .map((line) => (/^\s*--/.test(line) ? "" : line))
    .join("\n");
}

export function splitStatements(sql) {
  const src = stripLineComments(sql);
  const statements = [];
  let current = "";
  let i = 0;
  let dollarTag = null;

  while (i < src.length) {
    if (dollarTag) {
      const end = src.indexOf(dollarTag, i);
      if (end === -1) {
        current += src.slice(i);
        i = src.length;
      } else {
        current += src.slice(i, end + dollarTag.length);
        i = end + dollarTag.length;
        dollarTag = null;
      }
      continue;
    }

    const ch = src[i];

    if (ch === "$") {
      const m = /^\$[a-zA-Z_]*\$/.exec(src.slice(i, i + 64));
      if (m) {
        dollarTag = m[0];
        current += m[0];
        i += m[0].length;
        continue;
      }
    }

    if (ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (src[j] === "'") {
          j += 1;
          break;
        }
        j += 1;
      }
      current += src.slice(i, j);
      i = j;
      continue;
    }

    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current);
  return statements.map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Dangerous-statement classification
// ---------------------------------------------------------------------------

const FLAG_PATTERNS = [
  { type: "drop table", re: /^\s*drop\s+table\b/i },
  { type: "drop column", re: /\bdrop\s+column\b/i },
  { type: "alter table ... drop", re: /\balter\s+table\b[\s\S]*?\bdrop\b/i },
  { type: "rename column", re: /\brename\s+column\b/i },
  { type: "rename to", re: /\brename\s+to\b/i },
  { type: "alter type ... rename", re: /\balter\s+type\b[\s\S]*?\brename\b/i },
  { type: "drop function", re: /^\s*drop\s+function\b/i },
  { type: "drop policy", re: /^\s*drop\s+policy\b/i },
  { type: "drop trigger", re: /^\s*drop\s+trigger\b/i },
];

function classifyStatement(statement) {
  for (const { type, re } of FLAG_PATTERNS) {
    if (re.test(statement)) return type;
  }
  return null;
}

function extractName(statement, re) {
  const m = re.exec(statement);
  return m ? m[1] : null;
}

const DROP_FUNCTION_NAME_RE = /drop\s+function\s+if\s+exists\s+(?:[a-zA-Z0-9_]+\.)?"?([a-zA-Z0-9_]+)"?\s*\(/i;
const CREATE_FUNCTION_NAME_RE = /create\s+or\s+replace\s+function\s+(?:[a-zA-Z0-9_]+\.)?"?([a-zA-Z0-9_]+)"?\s*\(/i;
const DROP_POLICY_NAME_RE = /drop\s+policy\s+(?:if\s+exists\s+)?"?([a-zA-Z0-9_]+)"?\s+on\b/i;
const CREATE_POLICY_NAME_RE = /create\s+policy\s+"?([a-zA-Z0-9_]+)"?\s+on\b/i;
const DROP_TRIGGER_NAME_RE = /drop\s+trigger\s+(?:if\s+exists\s+)?"?([a-zA-Z0-9_]+)"?\s+on\b/i;
const CREATE_TRIGGER_NAME_RE = /create\s+(?:or\s+replace\s+)?trigger\s+"?([a-zA-Z0-9_]+)"?\b/i;

/**
 * Returns every flagged statement in `sql`, each `{ type, statement, exempt }`.
 * A caller filters to `!exempt` to decide whether the migration needs a
 * matching rollback script.
 */
export function findDangerousStatements(sql) {
  const statements = splitStatements(sql);
  const results = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    const type = classifyStatement(statement);
    if (!type) continue;

    let exempt = false;

    if (type === "drop function" && /\bif\s+exists\b/i.test(statement)) {
      const droppedName = extractName(statement, DROP_FUNCTION_NAME_RE);
      const next = statements[i + 1];
      if (droppedName && next) {
        const createdName = extractName(next, CREATE_FUNCTION_NAME_RE);
        if (createdName && createdName.toLowerCase() === droppedName.toLowerCase()) {
          exempt = true;
        }
      }
    }

    if (type === "drop policy") {
      const droppedName = extractName(statement, DROP_POLICY_NAME_RE);
      if (droppedName) {
        exempt = statements
          .slice(i + 1)
          .some((later) => {
            const createdName = extractName(later, CREATE_POLICY_NAME_RE);
            return createdName && createdName.toLowerCase() === droppedName.toLowerCase();
          });
      }
    }

    if (type === "drop trigger") {
      const droppedName = extractName(statement, DROP_TRIGGER_NAME_RE);
      if (droppedName) {
        exempt = statements
          .slice(i + 1)
          .some((later) => {
            const createdName = extractName(later, CREATE_TRIGGER_NAME_RE);
            return createdName && createdName.toLowerCase() === droppedName.toLowerCase();
          });
      }
    }

    results.push({ type, statement, exempt });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Rollback-script lookup
// ---------------------------------------------------------------------------

/** `supabase/migrations/20260101000000_x.sql` -> `20260101000000` (or null). */
export function migrationTimestamp(migrationPath) {
  const base = path.basename(migrationPath);
  const m = /^(\d{14})_/.exec(base);
  return m ? m[1] : null;
}

export function rollbackPathFor(migrationPath) {
  const ts = migrationTimestamp(migrationPath);
  if (!ts) return null;
  return path.join("supabase", "rollback", `${ts}_down.sql`);
}

export function hasRollbackScript(migrationPath, { exists = defaultExists } = {}) {
  const rollbackPath = rollbackPathFor(migrationPath);
  return rollbackPath != null && exists(rollbackPath);
}

function defaultExists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

// ---------------------------------------------------------------------------
// Per-migration check
// ---------------------------------------------------------------------------

/**
 * Checks one migration file. `deps.readFile`/`deps.exists` take a
 * ROOT-relative path (tests inject fakes; the CLI uses the real filesystem).
 */
export function checkMigrationFile(migrationPath, { readFile = defaultReadFile, exists = defaultExists } = {}) {
  const content = readFile(migrationPath);
  if (content == null) {
    return { file: migrationPath, violations: [], skipped: "file not found" };
  }
  const flagged = findDangerousStatements(content).filter((s) => !s.exempt);
  if (flagged.length === 0) {
    return { file: migrationPath, violations: [] };
  }
  if (hasRollbackScript(migrationPath, { exists })) {
    return { file: migrationPath, violations: [] };
  }
  return { file: migrationPath, violations: flagged, rollbackPath: rollbackPathFor(migrationPath) };
}

function defaultReadFile(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Git glue — which migration files are new since <base-ref>
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

export function newMigrationFiles(baseRef, { gitImpl = git } = {}) {
  let output;
  try {
    output = gitImpl(["diff", "--name-status", `${baseRef}...HEAD`, "--", "supabase/migrations"]);
  } catch (err) {
    throw new Error(
      `git diff against '${baseRef}' failed — is it a valid ref reachable from here? ` +
        `(in CI, fetch it first: 'git fetch origin main'). Original error: ${err.message}`,
    );
  }
  return output
    .split("\n")
    .filter(Boolean)
    .filter((line) => line.startsWith("A\t"))
    .map((line) => line.slice(2).trim())
    .filter((f) => f.endsWith(".sql"));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function formatViolation(v) {
  const snippet = v.statement.replace(/\s+/g, " ").trim().slice(0, 160);
  return `    [${v.type}] ${snippet}${v.statement.length > 160 ? "…" : ""}`;
}

function main() {
  const baseRef = process.argv[2];
  if (!baseRef) {
    console.error("Usage: node scripts/check-migrations.mjs <base-ref>");
    process.exit(1);
    return;
  }

  let files;
  try {
    files = newMigrationFiles(baseRef);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  if (files.length === 0) {
    console.log(`check-migrations: no new migrations since ${baseRef}.`);
    return;
  }

  const results = files.map((f) => checkMigrationFile(f));
  const bad = results.filter((r) => r.violations.length > 0);

  if (bad.length === 0) {
    console.log(`check-migrations: ${files.length} new migration(s) since ${baseRef}, all clear.`);
    return;
  }

  console.error(
    `check-migrations: ${bad.length} new migration(s) contain a statement that could break the ` +
      `running frontend (drop/rename without a tested down script) — CLAUDE.md forward-fix rule, ` +
      `owner decision 2026-09-14 #4.\n`,
  );
  for (const r of bad) {
    console.error(`  ${r.file}  (expects ${r.rollbackPath})`);
    for (const v of r.violations) console.error(formatViolation(v));
  }
  console.error(
    "\nEither this migration is truly additive-only and the statement is a false positive worth " +
      "narrowing this script for, or it needs a tested down script at the path shown above — see " +
      "supabase/rollback/README.md.",
  );
  process.exit(2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
