// Shared plumbing for the QA CLIs (scripts/qa/sadran.ts, member.ts): argument parsing, the
// mailbox, sign-in on the disposable stack, department/week resolution. Prints data and English
// labels only (Hebrew from the database is passed through untouched). The launcher (run.mjs) has
// already refused the owner's stack; `assertStack()` re-checks the URL the app client really uses.
import fs from "node:fs";
import path from "node:path";

import { supabase } from "@/integrations/supabase/client";
import { env } from "@/lib/env";
import { toAppError } from "@/lib/rpc";
import { fetchDepartments, fetchWeeks } from "@/features/siddur/api";

export const DEMO_PASSWORD = "nevo-demo-1234";

export interface Args {
  cmd: string;
  pos: string[];
  flags: Map<string, string[]>;
}

/** `cmd a b --flag value --bool --multi x --multi y` (a repeated flag keeps every value; flags may also precede the command; a boolean flag must be followed by another flag or be last). */
export function parseArgs(argv: string[]): Args {
  const rest = argv;
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags.set(name, [...(flags.get(name) ?? []), "true"]);
      else { flags.set(name, [...(flags.get(name) ?? []), next]); i++; }
    } else pos.push(token);
  }
  const cmd = pos.shift() ?? "help";
  return { cmd, pos, flags };
}

export const flag = (args: Args, name: string): string | undefined => args.flags.get(name)?.[args.flags.get(name)!.length - 1];
export const flagAll = (args: Args, name: string): string[] => args.flags.get(name) ?? [];
export const has = (args: Args, name: string): boolean => args.flags.has(name);

export class UsageError extends Error {}
export function need<T>(value: T | undefined | null | "", what: string): T {
  if (value === undefined || value === null || value === "") throw new UsageError(`missing ${what}`);
  return value as T;
}

export function assertStack(): void {
  const url = new URL(env.VITE_SUPABASE_URL);
  if (url.port === "54321" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    console.error(`REFUSED: ${env.VITE_SUPABASE_URL} is not a disposable QA stack.`);
    process.exit(3);
  }
}

// --- output dir, personas, mailbox -----------------------------------------------------------

export function outDir(args: Args): string {
  const dir = path.resolve(flag(args, "out") ?? process.env.QA_OUT ?? path.join(process.cwd(), ".qa-out"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

type Json = Record<string, unknown>;

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** Every object in the tree that looks like an account (`email` + `password`). */
function accountsIn(node: unknown, key = "", out: { key: string; value: Json }[] = []): { key: string; value: Json }[] {
  if (Array.isArray(node)) node.forEach((item) => accountsIn(item, key, out));
  else if (node && typeof node === "object") {
    const record = node as Json;
    if (typeof record.email === "string" && typeof record.password === "string") out.push({ key, value: record });
    for (const [childKey, child] of Object.entries(record)) accountsIn(child, childKey, out);
  }
  return out;
}

export interface Credentials { email: string; password: string }

/**
 * The QA Sadran account + department/week hints: `<out>/world.json` (`sadran`, `department.id`,
 * `weekStart`; the generator keeps it free of personas), else a `sadran` entry of `personas.json`.
 * Never reads or returns member data.
 */
export function sadranFromPersonas(out: string): (Credentials & { departmentId?: string; weekStart?: string }) | null {
  for (const file of ["world.json", "personas.json"]) {
    const data = readJson(path.join(out, file)) as Json | null;
    const sadran = data?.sadran as Json | undefined;
    if (!data || !sadran || typeof sadran.email !== "string") continue;
    const dept = data.department as Json | string | undefined;
    return {
      email: sadran.email, password: String(sadran.password ?? DEMO_PASSWORD),
      departmentId: typeof dept === "object" ? String(dept?.id ?? "") || undefined : String(data.departmentId ?? dept ?? "") || undefined,
      weekStart: String(data.weekStart ?? "") || undefined,
    };
  }
  return null;
}

/** Department/week hints for the member CLI (from `world.json`, else `personas.json`). */
export function scopeHint(out: string): { departmentId?: string; weekStart?: string } {
  for (const file of ["world.json", "personas.json"]) {
    const data = readJson(path.join(out, file)) as Json | null;
    if (!data) continue;
    const dept = data.department as Json | string | undefined;
    return { departmentId: typeof dept === "object" ? String(dept?.id ?? "") || undefined : String(data.departmentId ?? dept ?? "") || undefined, weekStart: String(data.weekStart ?? "") || undefined };
  }
  return {};
}

/** Password of a member email from `personas.json` (member CLI only), else the demo password. */
export function memberPassword(out: string, email: string): string {
  const data = readJson(path.join(out, "personas.json"));
  const found = data ? accountsIn(data).find((entry) => String(entry.value.email).toLowerCase() === email.toLowerCase()) : undefined;
  return found ? String(found.value.password) : email.endsWith(".qa.local") ? "qa-member-1234" : DEMO_PASSWORD;
}

export interface MailboxEntry { at: string; from: string; to: string; text: string; re?: string }

export function mailboxFile(out: string): string { return path.join(out, "mailbox.jsonl"); }

export function appendMail(out: string, entry: Omit<MailboxEntry, "at">): MailboxEntry {
  const full: MailboxEntry = { at: new Date().toISOString(), ...entry };
  fs.appendFileSync(mailboxFile(out), `${JSON.stringify(full)}\n`);
  return full;
}

export function readMail(out: string): MailboxEntry[] {
  try {
    return fs.readFileSync(mailboxFile(out), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as MailboxEntry);
  } catch { return []; }
}

/** Mail addressed to `reader` (or one of its `aliases`, e.g. "sadran"); with `onlyNew`, only what this reader has not listed before (cursor file). */
export function mailFor(out: string, reader: string, onlyNew: boolean, aliases: string[] = []): MailboxEntry[] {
  const all = readMail(out);
  const cursorFile = path.join(out, `.mailbox-cursor-${reader.replace(/[^a-z0-9]+/gi, "_")}`);
  const seen = onlyNew ? Number(fs.existsSync(cursorFile) ? fs.readFileSync(cursorFile, "utf8") : 0) || 0 : 0;
  fs.writeFileSync(cursorFile, String(all.length));
  const names = [reader, ...aliases].map((n) => n.toLowerCase());
  return all.slice(seen).filter((entry) => names.includes(entry.to.toLowerCase()));
}

export function printMail(entries: MailboxEntry[]): void {
  if (!entries.length) { console.log("(no messages)"); return; }
  for (const m of entries) console.log(`[${m.at}] ${m.from} -> ${m.to}${m.re ? ` (re ${m.re})` : ""}: ${m.text}`);
}

// --- session -----------------------------------------------------------------------------------

export async function signIn(creds: Credentials): Promise<{ id: string; email: string }> {
  assertStack();
  const { data, error } = await supabase.auth.signInWithPassword(creds);
  if (error || !data.user) throw new Error(`sign-in failed for ${creds.email}: ${error?.message ?? "no user"}`);
  return { id: data.user.id, email: creds.email };
}

export interface Scope { departmentId: string; departmentName: string; homeDestinationId: string; weekStart: string; phase: string }

/** Department (flag, personas file, else the only non-demo / only department) and week (flag, personas, else the newest open/solving/published/live). */
export async function resolveScope(args: Args, hint: { departmentId?: string; weekStart?: string } = {}): Promise<Scope> {
  const departments = await fetchDepartments();
  const wanted = flag(args, "dept") ?? process.env.QA_DEPT ?? hint.departmentId;
  const dept = wanted
    ? departments.find((d) => d.id === wanted || d.id.startsWith(wanted) || d.name === wanted)
    : (departments.length > 1 ? departments.find((d) => !d.id.endsWith("0001")) : undefined) ?? departments[0];
  if (!dept) throw new UsageError(`department not found (have: ${departments.map((d) => `${d.name}:${d.id}`).join(", ")})`);
  const weeks = await fetchWeeks(dept.id);
  const wantedWeek = flag(args, "week") ?? process.env.QA_WEEK ?? hint.weekStart;
  const week = wantedWeek
    ? weeks.find((w) => w.week_start === wantedWeek)
    : [...weeks].reverse().find((w) => ["open", "solving", "published", "live"].includes(w.phase)) ?? weeks[weeks.length - 1];
  if (!week) throw new UsageError(`week not found (have: ${weeks.map((w) => `${w.week_start}:${w.phase}`).join(", ")})`);
  return { departmentId: dept.id, departmentName: dept.name, homeDestinationId: dept.home_destination_id as string, weekStart: week.week_start, phase: week.phase };
}

/** Resolves a full id from a unique prefix or suffix (the 8-char form the CLIs print) among `ids`. */
export function resolveId(prefix: string, ids: readonly string[], what: string): string {
  const matches = ids.filter((id) => id === prefix || id.startsWith(prefix) || id.endsWith(prefix));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new UsageError(`${what} not found: ${prefix}`);
  throw new UsageError(`${what} prefix ${prefix} is ambiguous (${matches.slice(0, 5).map((m) => m.slice(-8)).join(", ")}...)`);
}

/** Last 8 hex chars (random in v4 uuids, and distinct for the demo seed ids); `resolveId` accepts them back. */
export const short = (id: string | null | undefined): string => (id ? id.slice(-8) : "-");

/** Runs `main`, prints a one-line `ERROR <code>: <message>` for app/usage errors, always exits (supabase timers keep the loop alive). */
export async function run(main: () => Promise<void>): Promise<never> {
  let code = 0;
  try { await main(); } catch (error) {
    code = 1;
    if (error instanceof UsageError) { console.error(`USAGE: ${error.message}`); code = 2; }
    else {
      const app = toAppError(error);
      const raw = error as { message?: string; details?: string; hint?: string; code?: string } | null;
      console.error(`ERROR ${app.code}${raw?.code ? ` [${raw.code}]` : ""}: ${app.message}${raw?.message && raw.message !== app.message ? ` | ${raw.message}` : ""}${raw?.details ? ` | ${raw.details}` : ""}${app.description ? ` | ${app.description}` : ""}`);
    }
  }
  process.exit(code);
}

export type PlaceValue = { presetId: string; name: string } | { freeText: string };

/** A place from a CLI token: `free:<text>` = free text, else a department place by id suffix/prefix, exact name, or name substring. */
export function resolvePlaceToken(destinations: readonly { id: string; name: string }[], token: string): PlaceValue {
  if (/^(free|text):/i.test(token)) return { freeText: token.replace(/^(free|text):/i, "").trim() };
  const byId = destinations.filter((d) => d.id === token || (token.length >= 6 && (d.id.startsWith(token) || d.id.endsWith(token))));
  const exact = destinations.filter((d) => d.name === token);
  const loose = destinations.filter((d) => d.name.includes(token));
  const found = byId.length ? byId : exact.length ? exact : loose;
  if (found.length === 1) return { presetId: found[0]!.id, name: found[0]!.name };
  if (found.length > 1) throw new UsageError(`place '${token}' is ambiguous: ${found.slice(0, 6).map((d) => d.name).join(", ")} (use free:<text> for free text)`);
  throw new UsageError(`place '${token}' not in the department list (use free:<text> for a free-text place)`);
}
