#!/usr/bin/env node
// `npm run qa:ui -- shot --as <email> --path <app path> [--day yyyy-mm-dd] --to <png> [--viewport mobile|desktop|WxH] [--out DIR]`
// Path placeholders: {dept} {week} (from <out>/world.json). Shortcuts: board | siddur | publish | proposals | my | inbox.
import fs from "node:fs";
import path from "node:path";

import { assertDisposable, qaEnv } from "./lib/stack.mjs";
import { openAs, scopeFrom, selectDay } from "./uiSession.mjs";

assertDisposable(qaEnv().VITE_SUPABASE_URL);

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { const next = argv[i + 1]; if (next === undefined || next.startsWith("--")) flags[argv[i].slice(2)] = true; else { flags[argv[i].slice(2)] = next; i++; } } else pos.push(argv[i]);
  }
  return { pos, flags };
}

const { pos, flags } = parse(process.argv.slice(2));
const cmd = pos[0] ?? "help";
if (cmd !== "shot") {
  console.log("usage: qa:ui shot --as <email> --path <app path|board|siddur|publish|proposals|my|inbox> [--day yyyy-mm-dd] --to <png> [--viewport mobile|desktop|WxH] [--out DIR] [--text]");
  process.exit(cmd === "help" ? 0 : 2);
}
const out = flags.out ?? process.env.QA_OUT;
if (out) process.env.QA_OUT = path.resolve(out);
const email = flags.as ?? (() => { throw new Error("--as <email> is required"); })();
const target = flags.to ?? "shot.png";
const { page, urls, close } = await openAs(email, { viewport: flags.viewport ?? (String(flags.path ?? "").match(/board/) ? "desktop" : "mobile"), out: process.env.QA_OUT });
try {
  const { dept, week } = scopeFrom(process.env.QA_OUT);
  const shortcut = { board: urls.board(), siddur: urls.siddur(), publish: urls.publish(), proposals: urls.proposals(), my: urls.my(), inbox: urls.inbox() };
  const appPath = shortcut[flags.path] ?? String(flags.path ?? "/my").replaceAll("{dept}", dept ?? "").replaceAll("{week}", week ?? "");
  await page.goto(appPath);
  await page.waitForLoadState("networkidle").catch(() => {});
  if (flags.day) {
    const ok = await selectDay(page, flags.day);
    if (!ok) console.error(`note: no day tab matching ${flags.day} found; screenshot shows the default day`);
  }
  await page.waitForTimeout(500);
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  await page.screenshot({ path: target, fullPage: !!flags.full });
  console.log(`saved ${path.resolve(target)} (${page.url()})`);
  if (flags.text) console.log((await page.locator("body").innerText()).slice(0, 6000));
} finally {
  await close();
}
