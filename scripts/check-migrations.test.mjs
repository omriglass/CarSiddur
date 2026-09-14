import { describe, expect, it } from "vitest";
import {
  checkMigrationFile,
  findDangerousStatements,
  hasRollbackScript,
  migrationTimestamp,
  newMigrationFiles,
  rollbackPathFor,
  splitStatements,
} from "./check-migrations.mjs";

describe("splitStatements", () => {
  it("splits plain statements on ';'", () => {
    expect(splitStatements("select 1; select 2;")).toEqual(["select 1", "select 2"]);
  });

  it("keeps a dollar-quoted function body as one statement", () => {
    const sql = `create or replace function public.foo() returns int as $$
begin
  return 1; -- not a statement boundary
end;
$$ language plpgsql;`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("begin");
    expect(statements[0]).toContain("end;");
  });

  it("does not split on a ';' inside a string literal", () => {
    const sql = `insert into t(v) values ('a; b'); select 1;`;
    expect(splitStatements(sql)).toEqual(["insert into t(v) values ('a; b')", "select 1"]);
  });

  it("handles escaped '' quotes inside a string literal", () => {
    const sql = `insert into t(v) values ('it''s; fine'); select 2;`;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("it''s; fine");
  });

  it("strips whole-line comments before splitting", () => {
    const sql = `-- drop table mentioned only in a comment\nselect 1;`;
    expect(splitStatements(sql)).toEqual(["select 1"]);
  });
});

describe("findDangerousStatements", () => {
  it("flags a plain drop table", () => {
    const results = findDangerousStatements("drop table public.foo;");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "drop table", exempt: false });
  });

  it("flags alter table ... drop column", () => {
    const results = findDangerousStatements("alter table public.foo drop column bar;");
    expect(results.some((r) => !r.exempt)).toBe(true);
  });

  it("flags rename column and rename to", () => {
    expect(findDangerousStatements("alter table public.foo rename column a to b;")[0]).toMatchObject({
      exempt: false,
    });
    expect(findDangerousStatements("alter table public.foo rename to bar;")[0]).toMatchObject({
      type: "rename to",
      exempt: false,
    });
  });

  it("flags alter type ... rename value", () => {
    const results = findDangerousStatements("alter type public.request_status rename value 'x' to 'y';");
    expect(results.some((r) => r.type === "alter type ... rename")).toBe(true);
  });

  it("flags a plain drop function with no matching create", () => {
    const results = findDangerousStatements("drop function public.foo(uuid);");
    expect(results).toHaveLength(1);
    expect(results[0].exempt).toBe(false);
  });

  it("exempts drop function if exists immediately followed by create or replace of the same name", () => {
    const sql = `
      drop function if exists public.foo(uuid, date);
      create or replace function public.foo(uuid, date, jsonb) returns void as $$
      begin
        null;
      end;
      $$ language plpgsql;
    `;
    const results = findDangerousStatements(sql);
    const dropped = results.find((r) => r.type === "drop function");
    expect(dropped.exempt).toBe(true);
  });

  it("does not exempt drop function if exists when the next statement is unrelated", () => {
    const sql = `
      drop function if exists public.foo(uuid);
      create table public.bar (id uuid);
    `;
    const results = findDangerousStatements(sql);
    const dropped = results.find((r) => r.type === "drop function");
    expect(dropped.exempt).toBe(false);
  });

  it("does not exempt a plain drop function (no 'if exists') even if recreated next", () => {
    const sql = `
      drop function public.foo(uuid);
      create or replace function public.foo(uuid, date) returns void as $$ begin null; end; $$ language plpgsql;
    `;
    const results = findDangerousStatements(sql);
    const dropped = results.find((r) => r.type === "drop function");
    expect(dropped.exempt).toBe(false);
  });

  it("exempts drop policy followed later (not necessarily immediately) by re-creation of the same name", () => {
    const sql = `
      drop policy "requests_select" on public.requests;
      grant select on public.requests to authenticated;
      create policy "requests_select" on public.requests for select using (true);
    `;
    const results = findDangerousStatements(sql);
    const dropped = results.find((r) => r.type === "drop policy");
    expect(dropped.exempt).toBe(true);
  });

  it("does not exempt drop policy when no re-creation of the same name follows", () => {
    const sql = `drop policy "requests_select" on public.requests;`;
    const results = findDangerousStatements(sql);
    expect(results[0].exempt).toBe(false);
  });

  it("exempts drop trigger followed by a re-creation of the same name", () => {
    const sql = `
      drop trigger rides_before_write on public.rides;
      create trigger rides_before_write before insert or update on public.rides
        for each row execute function public.rides_before_write();
    `;
    const results = findDangerousStatements(sql);
    const dropped = results.find((r) => r.type === "drop trigger");
    expect(dropped.exempt).toBe(true);
  });

  it("ignores harmless statements entirely", () => {
    expect(findDangerousStatements("create table public.foo (id uuid); select 1;")).toEqual([]);
  });
});

describe("migrationTimestamp / rollbackPathFor", () => {
  it("extracts the leading 14-digit timestamp", () => {
    expect(migrationTimestamp("supabase/migrations/20260914100100_add_thing.sql")).toBe("20260914100100");
  });

  it("returns null for a path with no timestamp prefix", () => {
    expect(migrationTimestamp("supabase/migrations/not_a_timestamp.sql")).toBeNull();
  });

  it("builds the expected rollback path", () => {
    expect(rollbackPathFor("supabase/migrations/20260914100100_add_thing.sql")).toBe(
      "supabase/rollback/20260914100100_down.sql",
    );
  });
});

describe("hasRollbackScript", () => {
  it("uses the injected exists() check", () => {
    const exists = (p) => p === "supabase/rollback/20260914100100_down.sql";
    expect(hasRollbackScript("supabase/migrations/20260914100100_add_thing.sql", { exists })).toBe(true);
    expect(hasRollbackScript("supabase/migrations/20260914999999_other.sql", { exists })).toBe(false);
  });
});

describe("checkMigrationFile", () => {
  it("reports no violations for an additive-only migration", () => {
    const readFile = () => "create table public.foo (id uuid primary key);";
    const result = checkMigrationFile("supabase/migrations/20260914100100_add_thing.sql", {
      readFile,
      exists: () => false,
    });
    expect(result.violations).toEqual([]);
  });

  it("reports a violation for a destructive migration with no rollback script", () => {
    const readFile = () => "drop table public.foo;";
    const result = checkMigrationFile("supabase/migrations/20260914100100_drop_thing.sql", {
      readFile,
      exists: () => false,
    });
    expect(result.violations).toHaveLength(1);
    expect(result.rollbackPath).toBe("supabase/rollback/20260914100100_down.sql");
  });

  it("clears a destructive migration when a matching rollback script exists", () => {
    const readFile = () => "drop table public.foo;";
    const exists = (p) => p === "supabase/rollback/20260914100100_down.sql";
    const result = checkMigrationFile("supabase/migrations/20260914100100_drop_thing.sql", { readFile, exists });
    expect(result.violations).toEqual([]);
  });

  it("skips a file it cannot read without crashing", () => {
    const result = checkMigrationFile("supabase/migrations/20260914100100_missing.sql", {
      readFile: () => null,
      exists: () => false,
    });
    expect(result.violations).toEqual([]);
    expect(result.skipped).toBeTruthy();
  });
});

describe("newMigrationFiles", () => {
  it("keeps only added (status A) .sql files under supabase/migrations", () => {
    const gitImpl = () =>
      [
        "A\tsupabase/migrations/20260914100100_add_thing.sql",
        "M\tsupabase/migrations/20260907090000_extensions_and_enums.sql",
        "A\tsrc/lib/enums.ts",
        "D\tsupabase/migrations/20260101000000_old.sql",
        "",
      ].join("\n");
    expect(newMigrationFiles("origin/main", { gitImpl })).toEqual([
      "supabase/migrations/20260914100100_add_thing.sql",
    ]);
  });

  it("wraps a git failure with a helpful message", () => {
    const gitImpl = () => {
      throw new Error("unknown revision");
    };
    expect(() => newMigrationFiles("not-a-real-ref", { gitImpl })).toThrow(/git diff against 'not-a-real-ref'/);
  });
});
