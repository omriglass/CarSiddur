#!/usr/bin/env node
/**
 * AI1 step 0 (docs/TODO.md "Ask in words"): score the "ask in words" prompt against Gemini on the evaluation set.
 *
 *   node scripts/ai-eval/run.mjs --list-models
 *   node scripts/ai-eval/run.mjs --model <id> [--only <case-id,...>] [--delay <ms>]
 *
 * The key is GEMINI_API_KEY in supabase/functions/.env (gitignored) or the environment; it is never printed.
 * Each answer is scored after `normalizeAnswer` (our checks), as the edge function will return it. A case with
 * `previous: { answer, messages }` is a follow-up turn: `answer` (a model-shaped answer) becomes the stored draft.
 * Results go to .ai-eval/ (gitignored). The prompt and schema are the edge function's own
 * (supabase/functions/_shared/askPrompt.ts, loaded through Node's type stripping).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeAnswer } from "../../supabase/functions/_shared/askNormalize.ts";
import { buildGenerateRequest, PROMPT_VERSION } from "../../supabase/functions/_shared/askPrompt.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = "https://generativelanguage.googleapis.com/v1beta";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const envFile = join(root, "supabase", "functions", ".env");
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8").split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
    const value = line?.slice("GEMINI_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
    if (value) return value;
  }
  console.error("GEMINI_API_KEY is not set (supabase/functions/.env or the environment).");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, init, key) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${path}`, {
      ...init, signal: AbortSignal.timeout(90_000),
      headers: { "content-type": "application/json", "x-goog-api-key": key, ...init?.headers },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = 2000 * 2 ** attempt;
      console.log(`        HTTP ${res.status}, retrying in ${wait / 1000} s`);
      await sleep(wait);
      continue;
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.error?.message ?? "unknown error"}`);
    return body;
  }
}

async function listModels(key) {
  const out = [];
  let pageToken = "";
  do {
    const page = await call(`models?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`, { method: "GET" }, key);
    out.push(...(page.models ?? []));
    pageToken = page.nextPageToken ?? "";
  } while (pageToken);
  for (const m of out.filter((m) => m.supportedGenerationMethods?.includes("generateContent"))) {
    console.log(`${m.name.replace(/^models\//, "")}\t${m.displayName ?? ""}`);
  }
}

// ---- scoring ---------------------------------------------------------------------------------------------
const sameSet = (a = [], b = []) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

function placeMatches(expected, actual) {
  if (expected === null) return actual === null || (!actual?.text && !actual?.list_name);
  if (typeof expected === "string") return actual?.list_name === expected;
  if (expected.list_name === null) return !!actual && actual.list_name === null && (!expected.text_contains || (actual.text ?? "").includes(expected.text_contains));
  return false;
}

function stopsMatch(expected, actual = []) {
  if (expected.length !== actual.length) return false;
  return expected.every((e) => actual.some((a) => a.leg === e.leg
    && (e.place ? a.list_name === e.place || (a.text ?? "").includes(e.place) : (a.text ?? "").includes(e.place_text_contains))));
}

function scoreField(field, expected, actual) {
  switch (field) {
    case "destination":
    case "origin": return placeMatches(expected, actual[field]);
    case "people":
    case "remove_people":
    case "needs": return sameSet(expected, actual[field] ?? []);
    case "stops": return stopsMatch(expected, actual.stops);
    default: return (actual[field] ?? null) === expected;
  }
}

// ---- run -------------------------------------------------------------------------------------------------
async function main() {
  const key = apiKey();
  if (flag("list-models")) return listModels(key);
  const model = arg("model");
  if (!model) { console.error("--model <id> is required (see --list-models)."); process.exit(2); }
  const delay = Number(arg("delay", "4500"));
  const only = arg("only")?.split(",") ?? null;
  const { context, cases } = JSON.parse(readFileSync(join(root, "scripts", "ai-eval", "cases.json"), "utf8"));
  const selected = only ? cases.filter((c) => only.includes(c.id)) : cases;

  const results = [];
  const perField = {};
  for (const [i, c] of selected.entries()) {
    if (i > 0) await sleep(delay);
    const started = Date.now();
    let actual = null;
    let raw = null;
    let error = null;
    try {
      // a follow-up case: the previous turn's draft, made by our checks exactly as the edge function stores it
      const previousDraft = c.previous ? normalizeAnswer(c.previous.answer, context) : null;
      const previous = c.previous ? { draft: previousDraft, messages: c.previous.messages ?? [] } : null;
      const body = await call(`models/${model}:generateContent`, { method: "POST", body: JSON.stringify(buildGenerateRequest(context, c.text, previous)) }, key);
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      raw = JSON.parse(text);
      actual = normalizeAnswer(raw, context, previousDraft);
    } catch (e) {
      error = String(e.message ?? e);
    }
    const ms = Date.now() - started;
    const misses = [];
    for (const [field, expected] of Object.entries(c.expect)) {
      const ok = !!actual && scoreField(field, expected, actual);
      perField[field] ??= { ok: 0, total: 0 };
      perField[field].total++;
      if (ok) perField[field].ok++;
      else misses.push({ field, expected, got: actual ? actual[field] ?? null : null });
    }
    const pass = !error && misses.length === 0;
    results.push({ id: c.id, text: c.text, pass, ms, error, misses, actual, raw });
    console.log(`${pass ? "PASS" : "FAIL"}  ${c.id}  (${ms} ms)${error ? `  ${error}` : ""}`);
    for (const m of misses) console.log(`        ${m.field}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
  }

  const passed = results.filter((r) => r.pass).length;
  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${model} · prompt ${PROMPT_VERSION}: ${passed}/${results.length} cases fully right`);
  for (const [field, { ok, total }] of Object.entries(perField).sort()) console.log(`  ${field.padEnd(20)} ${ok}/${total}`);
  console.log(`  median latency ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms`);

  const outDir = join(root, ".ai-eval");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${model.replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ model, promptVersion: PROMPT_VERSION, passed, total: results.length, perField, results }, null, 2));
  console.log(`  details: ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
