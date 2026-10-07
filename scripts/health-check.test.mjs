import { describe, expect, it } from "vitest";
import {
  buildChecks,
  buildScript,
  exitCodeFor,
  formatLine,
  parseArgs,
  parseResults,
  pgEnvFromUrl,
  scopeWeeks,
  summarize,
} from "./health-check.mjs";

const DEPT = "00000000-0000-0000-0000-000000000001";

describe("parseArgs", () => {
  it("parses flags and values", () => {
    const a = parseArgs(["--container", "c1", "--dept", DEPT, "--from", "2026-10-01", "--include-archived"]);
    expect(a).toMatchObject({ container: "c1", dept: DEPT, from: "2026-10-01", includeArchived: true, yesRemote: false });
    expect(a.errors).toEqual([]);
  });

  it("rejects bad uuid/date and unknown flags (nothing reaches SQL unvalidated)", () => {
    expect(parseArgs(["--dept", "x'; drop table rides; --"]).errors).toHaveLength(1);
    expect(parseArgs(["--from", "yesterday"]).errors).toHaveLength(1);
    expect(parseArgs(["--bogus"]).errors).toHaveLength(1);
  });

  it("takes the remote url from HEALTH_DB_URL but lets an explicit --container win", () => {
    expect(parseArgs([], { HEALTH_DB_URL: "postgresql://u:p@h/db" }).dbUrl).toBe("postgresql://u:p@h/db");
    expect(parseArgs(["--container", "c"], { HEALTH_DB_URL: "postgresql://u:p@h/db" }).dbUrl).toBeNull();
    expect(parseArgs(["--container", "c", "--db-url", "postgresql://u:p@h/db"]).errors).toHaveLength(1);
  });
});

describe("pgEnvFromUrl", () => {
  it("splits the url into PG* variables", () => {
    expect(pgEnvFromUrl("postgresql://postgres.abc:p%40ss@aws-0.pooler.supabase.com:6543/postgres?sslmode=require")).toEqual({
      PGHOST: "aws-0.pooler.supabase.com",
      PGPORT: "6543",
      PGUSER: "postgres.abc",
      PGPASSWORD: "p@ss",
      PGDATABASE: "postgres",
      PGSSLMODE: "require",
    });
  });
  it("refuses non-postgres urls", () => {
    expect(() => pgEnvFromUrl("https://example.com")).toThrow();
  });
});

describe("checks and script", () => {
  const checks = buildChecks({ dept: DEPT, from: "2026-10-01", includeArchived: false });

  it("has unique ids and valid levels", () => {
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
    for (const c of checks) expect(["error", "warn", "info"]).toContain(c.level);
  });

  it("scopes weeks by department, date and archived", () => {
    const s = scopeWeeks({ dept: DEPT, from: "2026-10-01", includeArchived: false });
    expect(s).toContain(`department_id = '${DEPT}'`);
    expect(s).toContain("date '2026-10-01'");
    expect(s).toContain("phase <> 'archived'");
    expect(scopeWeeks({ includeArchived: true })).not.toContain("archived");
  });

  it("is read-only: one read-only transaction that rolls back, no writes", () => {
    const script = buildScript(checks);
    expect(script.startsWith("begin read only;")).toBe(true);
    expect(script.trimEnd().endsWith("rollback;")).toBe(true);
    expect(script).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|drop\s|alter\s|truncate|create\s)/i);
    expect(script).not.toMatch(/\bperform\b|enqueue_notification|flag_car_chain_breaks\(/);
  });
});

describe("results", () => {
  const checks = [
    { id: "a", level: "error", title: "A" },
    { id: "b", level: "warn", title: "B" },
    { id: "c", level: "info", title: "C" },
  ];
  const out = [
    "noise",
    `HC\ta\t2\t${JSON.stringify([{ id: "r1", d: "one" }, { id: "r2", d: "two" }])}`,
    `HC\tb\t0\t[]`,
    `HC\tc\t3\t[]`,
  ].join("\n");

  it("parses HC lines only", () => {
    const r = parseResults(out);
    expect(r.get("a")).toEqual({ count: 2, samples: [{ id: "r1", d: "one" }, { id: "r2", d: "two" }] });
    expect(r.size).toBe(3);
  });

  it("formats ok / hit / failed lines", () => {
    const r = parseResults(out);
    expect(formatLine(checks[0], r.get("a"))).toMatch(/^ERROR\s+2\s+a\s+A\n\s+e\.g\. r1 \(one\); r2 \(two\)$/);
    expect(formatLine(checks[1], r.get("b"))).toMatch(/^ok\s+0\s+b\s+B$/);
    expect(formatLine(checks[1], undefined)).toMatch(/^FAIL/);
  });

  it("exits 1 only for error rows, 2 for checks that could not run", () => {
    expect(exitCodeFor(checks, parseResults(out))).toBe(1);
    expect(exitCodeFor(checks, parseResults(out.replace("HC\ta\t2", "HC\ta\t0")))).toBe(0);
    const missing = parseResults(`HC\ta\t0\t[]\nHC\tb\t5\t[]`);
    expect(exitCodeFor(checks, missing)).toBe(2);
    expect(summarize(checks, missing)).toContain("1 check(s) could not run");
  });
});
