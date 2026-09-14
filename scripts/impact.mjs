#!/usr/bin/env node
// npm run impact -- [<base-ref>] [--staged] [--files <path...>] [--strict]
//
// Change -> tests -> QA impact tool (docs/TEST_MAP.md, test-map.json).
//
// Reads the set of changed files (via `git diff`, `git diff --cached`, or an
// explicit list), matches each path against every area's glob patterns in
// test-map.json, and prints: the affected areas, the exact Vitest/SQL/
// Playwright commands to run, and the QA checklist to paste into a PR /
// hand to a tester. In --strict mode, exits 2 if any changed file matches no
// area at all (for CI to fail loudly on drift between the map and the code).
//
// Also validates that test-map.json and docs/TEST_MAP.md list the same set
// of area ids (they are meant to be twins) — a mismatch is always fatal
// (exit 1), independent of --strict, since it means the two deliverables
// have drifted apart.
//
// This script has no runtime dependencies beyond Node's built-ins: the glob
// matcher below is a small hand-rolled `**`/`*` implementation, not
// picomatch/minimatch, so `npm run impact` never needs a new dependency.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

/**
 * Compile a minimal glob pattern into a RegExp anchored to the whole string.
 * Supported: a double-star segment matches any number of path segments,
 * including zero (so "a" then a double-star then "b" also matches plain
 * "a/b"); a single star matches anything but "/"; "?" matches one character
 * but "/"; every other character is literal (regex metacharacters escaped).
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2; // consume the trailing '/' too
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchGlob(glob, filePath) {
  return globToRegExp(glob).test(filePath);
}

export function loadTestMap(root = ROOT) {
  const raw = fs.readFileSync(path.join(root, "test-map.json"), "utf8");
  return JSON.parse(raw);
}

/** Area ids referenced by `### <id> — <title>` headings in docs/TEST_MAP.md. */
export function areaIdsInMarkdown(root = ROOT) {
  const md = fs.readFileSync(path.join(root, "docs", "TEST_MAP.md"), "utf8");
  const ids = [];
  const re = /^### ([a-z0-9-]+) — /gm;
  let m;
  while ((m = re.exec(md))) ids.push(m[1]);
  return ids;
}

/** Cross-check test-map.json and docs/TEST_MAP.md list the same area ids. */
export function checkMapConsistency(map, root = ROOT) {
  const jsonIds = new Set(map.areas.map((a) => a.id));
  const mdIds = new Set(areaIdsInMarkdown(root));
  const onlyInJson = [...jsonIds].filter((id) => !mdIds.has(id));
  const onlyInMd = [...mdIds].filter((id) => !jsonIds.has(id));
  return { ok: onlyInJson.length === 0 && onlyInMd.length === 0, onlyInJson, onlyInMd };
}

/**
 * Match one changed file against every area's `paths` globs, then apply
 * `migrationContentRules` (content-based, for the handful of especially
 * cross-cutting SQL symbols that don't have a stable filename convention).
 * Returns the set of area ids this file affects.
 */
/** True if `filePath` matches one of test-map.json's top-level `ignorePaths` globs. */
export function isIgnored(map, filePath) {
  return (map.ignorePaths ?? []).some((glob) => matchGlob(glob, filePath));
}

export function areasForFile(map, filePath, { readFile = defaultReadFile } = {}) {
  const areas = new Set();
  for (const area of map.areas) {
    if (area.paths.some((glob) => matchGlob(glob, filePath))) areas.add(area.id);
  }
  if (/^supabase\/migrations\/.*\.sql$/.test(filePath)) {
    const content = readFile(filePath);
    if (content != null) {
      for (const rule of map.migrationContentRules ?? []) {
        if (content.includes(rule.match)) {
          for (const id of rule.areas) areas.add(id);
        }
      }
    }
  }
  return areas;
}

function defaultReadFile(filePath) {
  const abs = path.join(ROOT, filePath);
  if (!fs.existsSync(abs)) return null;
  try {
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function changedFiles({ staged, files, baseRef }) {
  if (files && files.length > 0) return files;
  if (staged) {
    return git(["diff", "--name-only", "--cached"]).split("\n").filter(Boolean);
  }
  // Three-dot diff (merge-base) — the usual "what does this branch add on
  // top of where it forked from main" comparison; degrades gracefully to a
  // plain two-dot diff (equivalent for a ref that HEAD is a linear
  // descendant of, e.g. `HEAD~3`) if the ref has no merge-base with HEAD.
  try {
    return git(["diff", "--name-only", `${baseRef}...HEAD`]).split("\n").filter(Boolean);
  } catch (err) {
    throw new Error(
      `git diff against '${baseRef}' failed — is it a valid ref reachable from here? ` +
        `(in CI, fetch it first: 'git fetch origin main'). Original error: ${err.message}`,
    );
  }
}

function parseArgs(argv) {
  const args = { baseRef: "origin/main", staged: false, files: null, strict: false };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift();
    if (a === "--staged") args.staged = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--files") args.files = [...rest.splice(0, rest.length)];
    else if (!a.startsWith("--")) args.baseRef = a;
    else throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

function formatReport({ map, affected, unmatched, ignored, mode }) {
  const lines = [];
  lines.push(`Impact analysis (${mode})`);
  lines.push("");

  if (affected.size === 0) {
    lines.push("No changed file matches a mapped area. Nothing to report.");
  } else {
    const areasById = new Map(map.areas.map((a) => [a.id, a]));
    const ordered = map.areas.filter((a) => affected.has(a.id));

    lines.push(`Affected areas (${ordered.length}):`);
    for (const area of ordered) {
      lines.push(`  - ${area.id} — ${area.title}`);
    }
    lines.push("");

    lines.push("Run locally:");
    const vitestArgs = [...new Set(ordered.flatMap((a) => a.vitest))];
    if (vitestArgs.length > 0) {
      lines.push(`  npx vitest run ${vitestArgs.join(" ")}`);
    }
    const sqlSuites = [...new Set(ordered.flatMap((a) => a.sql))];
    if (sqlSuites.length > 0) {
      lines.push(
        `  npm run db:test   # all-or-nothing today (runs every suite) — the suites that specifically ` +
          `prove this change: ${sqlSuites.join(", ")}`,
      );
    }
    const tags = [...new Set(ordered.flatMap((a) => a.playwrightTags))];
    if (tags.length > 0) {
      const grep = tags.map((t) => t.replace(/^@/, "")).join("|");
      lines.push(`  npx playwright test --grep "@(${grep})"`);
    } else {
      lines.push("  (no Playwright tag for this area yet — see docs/TEST_MAP.md coverage gaps)");
    }
    lines.push("");

    lines.push("QA checklist (paste into the PR / hand to QA):");
    let n = 1;
    for (const area of ordered) {
      for (const step of area.qaChecklist ?? []) {
        lines.push(`  ${n}. [${area.id}] ${step}`);
        n += 1;
      }
    }
    lines.push("");
  }

  if (unmatched.length > 0) {
    lines.push(`⚠️  ${unmatched.length} changed file(s) match NO area in test-map.json:`);
    for (const f of unmatched) lines.push(`   - ${f}`);
    lines.push(
      "   Add a glob to the right area's \"paths\" in test-map.json (and, if it's a new " +
        "screen/flow/suite, docs/TEST_MAP.md) in the same change — CLAUDE.md hard rule 7.",
    );
  } else if (affected.size > 0) {
    lines.push("Every changed (non-ignored) file matches at least one area. ✓");
  }
  if (ignored > 0) {
    lines.push(`(${ignored} changed file(s) skipped: docs/tooling covered by test-map.json's "ignorePaths".)`);
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const map = loadTestMap();

  const consistency = checkMapConsistency(map);
  if (!consistency.ok) {
    console.error("test-map.json and docs/TEST_MAP.md area ids have drifted apart:");
    if (consistency.onlyInJson.length > 0) {
      console.error(`  only in test-map.json: ${consistency.onlyInJson.join(", ")}`);
    }
    if (consistency.onlyInMd.length > 0) {
      console.error(`  only in docs/TEST_MAP.md: ${consistency.onlyInMd.join(", ")}`);
    }
    process.exit(1);
  }

  let files;
  let mode;
  try {
    if (args.files) {
      files = args.files;
      mode = `--files (${files.length} given)`;
    } else if (args.staged) {
      files = changedFiles({ staged: true });
      mode = "--staged";
    } else {
      files = changedFiles({ baseRef: args.baseRef });
      mode = `vs ${args.baseRef}`;
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  files = files.filter(Boolean);
  if (files.length === 0) {
    console.log(`Impact analysis (${mode})\n\nNo changed files.`);
    return;
  }

  const affected = new Set();
  const unmatched = [];
  let ignored = 0;
  for (const f of files) {
    if (isIgnored(map, f)) {
      ignored += 1;
      continue;
    }
    const areas = areasForFile(map, f);
    if (areas.size === 0) unmatched.push(f);
    for (const id of areas) affected.add(id);
  }

  console.log(
    formatReport({
      map,
      affected,
      unmatched,
      ignored,
      mode: `${mode}, ${files.length} file(s) changed`,
    }),
  );

  if (args.strict && unmatched.length > 0) {
    process.exit(2);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
