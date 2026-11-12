#!/usr/bin/env node
// scripts/perf/snapshot.mjs — record production load while the Sadran works (TODO PF1).
//
// Production is only READ: every snapshot is the single SELECT in snapshot.sql, run through the
// stored Supabase CLI login (`supabase db query --linked`). Snapshots go to .perf/ (gitignored:
// query texts and counts only, but kept out of git like .debug/).
//
//   watch [--every <minutes>] [--for <minutes>]   a snapshot now and every N minutes (default 3, for 240)
//   once                                          one snapshot
//   report [--file <jsonl>]                       what happened between consecutive snapshots
//
// Read the report next to the dashboard's memory / swap / disk-IO / CPU graphs for the same minutes:
// a falling cache hit ratio with more disk reads while the same queries take longer per call (without
// more calls) points to memory pressure; more calls at the same cost per call points to load.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OUT_DIR = path.join(ROOT, ".perf");
const SQL_FILE = path.join(ROOT, "scripts/perf/snapshot.sql");
const TEXTS_SQL_FILE = path.join(ROOT, "scripts/perf/texts.sql");
const TEXTS_FILE = path.join(OUT_DIR, "texts.json");
const TEXTS_MIN_GAP_MS = 30 * 60000;
let textsReadAt = 0;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`perf: ${message}`);
  process.exit(1);
}

function query(sqlFile, column) {
  const res = spawnSync("npx", ["supabase", "db", "query", "--linked", "-o", "json", "-f", sqlFile], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  // Plain `-o json` prints an array of rows; under an AI agent the CLI wraps it as { boundary, rows }.
  const starts = [res.stdout.indexOf("["), res.stdout.indexOf("{")].filter((i) => i >= 0);
  const start = starts.length ? Math.min(...starts) : -1;
  if (res.status !== 0 || start < 0) throw new Error((res.stderr || res.stdout).slice(-2000));
  const close = res.stdout[start] === "[" ? "]" : "}";
  const body = JSON.parse(res.stdout.slice(start, res.stdout.lastIndexOf(close) + 1));
  const value = (Array.isArray(body) ? body : body.rows)?.[0]?.[column];
  if (!value) throw new Error(`no ${column} row`);
  return typeof value === "string" ? JSON.parse(value) : value;
}

function knownTexts() {
  return existsSync(TEXTS_FILE) ? JSON.parse(readFileSync(TEXTS_FILE, "utf8")) : {};
}

// The texts are read apart from the snapshots (texts.sql says why): only for a statement not seen before.
function readMissingTexts(snap) {
  const texts = knownTexts();
  if (snap.statements.every((s) => texts[s.id]) || Date.now() - textsReadAt < TEXTS_MIN_GAP_MS) return;
  textsReadAt = Date.now();
  writeFileSync(TEXTS_FILE, JSON.stringify({ ...texts, ...query(TEXTS_SQL_FILE, "texts") }));
}

function fileFor(date) {
  return path.join(OUT_DIR, `${date.toISOString().slice(0, 10)}.jsonl`);
}

function record() {
  mkdirSync(OUT_DIR, { recursive: true });
  const snap = query(SQL_FILE, "snapshot");
  const file = fileFor(new Date(snap.at));
  appendFileSync(file, `${JSON.stringify(snap)}\n`);
  try { readMissingTexts(snap); } catch (e) { console.error(`perf: query texts not read: ${e.message.split("\n")[0]}`); }
  const conns = snap.connections.reduce((n, c) => n + Number(c.n), 0);
  console.log(`${snap.at}  connections ${conns}  longest active ${snap.longest_active_ms} ms  client errors (1 h) ${snap.client_errors_1h}  → ${path.relative(ROOT, file)}`);
}

function hitRatio(hit, read) {
  return hit + read === 0 ? "—" : `${((100 * hit) / (hit + read)).toFixed(2)}%`;
}

function report(file) {
  const snaps = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  if (snaps.length < 2) fail(`${file} has ${snaps.length} snapshot(s); a report needs two`);
  const texts = knownTexts();
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1];
    const b = snaps[i];
    const hit = b.db.blks_hit - a.db.blks_hit;
    const read = b.db.blks_read - a.db.blks_read;
    const minutes = (new Date(b.at) - new Date(a.at)) / 60000;
    const conns = b.connections.reduce((n, c) => n + Number(c.n), 0);
    console.log(`\n${a.at.slice(11, 16)}–${b.at.slice(11, 16)} UTC (${minutes.toFixed(1)} min)  cache hit ${hitRatio(hit, read)}  disk blocks read ${read}  ` +
      `temp ${((b.db.temp_bytes - a.db.temp_bytes) / 1e6).toFixed(1)} MB  commits ${b.db.xact_commit - a.db.xact_commit}  ` +
      `connections ${conns}  waits ${b.waits.map((w) => `${w.type}:${w.event}×${w.n}`).join(" ") || "none"}  client errors (1 h) ${b.client_errors_1h}`);
    const before = new Map(a.statements.map((s) => [s.id, s]));
    const rows = b.statements
      .map((s) => {
        const p = before.get(s.id);
        if (!p) return null;
        const calls = s.calls - p.calls;
        const ms = s.total_ms - p.total_ms;
        return calls > 0 ? { calls, ms, avg: ms / calls, read: s.read - p.read, query: s.query ?? texts[s.id] ?? `statement ${s.id}` } : null;
      })
      .filter(Boolean)
      .sort((x, y) => y.ms - x.ms)
      .slice(0, 12);
    for (const r of rows) {
      console.log(`  ${String(Math.round(r.ms)).padStart(8)} ms  ${String(r.calls).padStart(6)} calls  avg ${r.avg.toFixed(0).padStart(5)} ms  disk ${String(r.read).padStart(6)}  ${r.query.slice(0, 90)}`);
    }
  }
}

const command = process.argv[2];
if (command === "once") {
  record();
} else if (command === "watch") {
  const every = Number(arg("every", "3"));
  const total = Number(arg("for", "240"));
  const until = Date.now() + total * 60000;
  const tick = () => {
    try { record(); } catch (e) { console.error(`perf: snapshot failed: ${e.message.split("\n")[0]}`); }
    if (Date.now() + every * 60000 <= until) setTimeout(tick, every * 60000);
  };
  tick();
} else if (command === "report") {
  const file = arg("file") ?? (existsSync(OUT_DIR)
    ? path.join(OUT_DIR, readdirSync(OUT_DIR).filter((f) => f.endsWith(".jsonl")).sort().at(-1) ?? "")
    : "");
  if (!file || !existsSync(file)) fail("no snapshots yet (.perf/)");
  report(file);
} else {
  fail("usage: snapshot.mjs watch [--every <min>] [--for <min>] | once | report [--file <jsonl>]");
}
