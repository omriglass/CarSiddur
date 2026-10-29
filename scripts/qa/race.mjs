#!/usr/bin/env node
// Concurrency QA (skill `/qa-concurrent`): run two `qa:sadran` commands as two different Sadrans so they reach the
// database at the same instant. Each side loads its board first (a few seconds of vite-node + reads), then waits for the
// shared `--at` instant (scripts/qa/sadran.ts `waitUntilFireTime`) - i.e. both act on the same, soon stale, state, the
// way two Sadrans with the same board open would.
//
//   node scripts/qa/race.mjs --a "move 1a2b3c4d --start 09:00" --b "unassign 1a2b3c4d" \
//     [--a-email sadran@s7.qa.local] [--b-email sadran2@s7.qa.local] [--password qa-member-1234] [--delay 25]
//
// Same environment as the other QA tools (QA_API_URL, QA_OUT; the owner's stack is refused). Prints both outputs and
// exit codes; exits 0 either way (a refusal on one side is usually the correct outcome - judge it, then run the
// invariants).
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertDisposable, qaEnv } from "./lib/stack.mjs";

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** Splits a command string on spaces, keeping "double quoted" parts together. */
function words(text) {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

const a = argValue("a");
const b = argValue("b");
if (!a || !b) {
  console.error('usage: race.mjs --a "<qa:sadran command>" --b "<qa:sadran command>" [--a-email E] [--b-email E] [--password P] [--delay S]');
  process.exit(2);
}
const env = qaEnv();
assertDisposable(env.VITE_SUPABASE_URL);
const out = process.env.QA_OUT;
const world = out ? JSON.parse(fs.readFileSync(path.join(out, "world.json"), "utf8")) : null;
const aEmail = argValue("a-email", world?.sadran?.email);
const bEmail = argValue("b-email", world?.sadran?.email?.replace(/^sadran@/, "sadran2@"));
const password = argValue("password", world?.sadran?.password ?? "qa-member-1234");
const fireAt = Date.now() + Number(argValue("delay", "25")) * 1000;
const root = fileURLToPath(new URL("../../", import.meta.url));

function side(label, email, command) {
  return new Promise((resolve) => {
    const child = spawn("node", ["scripts/qa/run.mjs", "sadran", ...words(command), "--email", email, "--password", password, "--at", String(fireAt)], {
      cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.on("data", (chunk) => { text += chunk; });
    child.on("exit", (code) => resolve({ label, email, command, code, text }));
  });
}

console.log(`race: both fire at ${new Date(fireAt).toISOString()}`);
const results = await Promise.all([side("A", aEmail, a), side("B", bEmail, b)]);
for (const r of results) {
  console.log(`\n=== ${r.label} (${r.email}) exit=${r.code}: ${r.command}`);
  console.log(r.text.split("\n").filter((line) => !/^\s*$|^>|npm (warn|notice)/.test(line)).join("\n"));
}
