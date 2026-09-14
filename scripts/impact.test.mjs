import { describe, expect, it } from "vitest";
import {
  areaIdsInMarkdown,
  areasForFile,
  checkMapConsistency,
  isIgnored,
  loadTestMap,
  matchGlob,
  ROOT,
} from "./impact.mjs";

describe("matchGlob", () => {
  it("matches a literal path", () => {
    expect(matchGlob("src/features/requests/api.ts", "src/features/requests/api.ts")).toBe(true);
    expect(matchGlob("src/features/requests/api.ts", "src/features/requests/apix.ts")).toBe(false);
  });

  it("matches '*' within one path segment only", () => {
    expect(matchGlob("src/lib/*.ts", "src/lib/time.ts")).toBe(true);
    expect(matchGlob("src/lib/*.ts", "src/lib/sub/time.ts")).toBe(false);
  });

  it("matches '**' across any number of segments, including zero", () => {
    expect(matchGlob("src/solver/**", "src/solver/index.ts")).toBe(true);
    expect(matchGlob("src/solver/**", "src/solver/rules/distance.ts")).toBe(true);
    expect(matchGlob("supabase/migrations/**/*waitlist*", "supabase/migrations/20260910_waitlist_groups.sql")).toBe(
      true,
    );
    expect(
      matchGlob("supabase/migrations/**/*waitlist*", "supabase/migrations/nested/20260910_waitlist_groups.sql"),
    ).toBe(true);
  });

  it("does not match a different top-level directory", () => {
    expect(matchGlob("src/solver/**", "src/features/solver/index.ts")).toBe(false);
  });

  it("escapes regex metacharacters in literal segments", () => {
    expect(matchGlob("eslint.config.js", "eslint.config.js")).toBe(true);
    expect(matchGlob("eslint.config.js", "eslintXconfigXjs")).toBe(false);
  });
});

describe("test-map.json / docs/TEST_MAP.md consistency", () => {
  it("list exactly the same area ids", () => {
    const map = loadTestMap();
    const result = checkMapConsistency(map);
    expect(result.onlyInJson).toEqual([]);
    expect(result.onlyInMd).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("every area in test-map.json has a title, paths, vitest, sql, playwrightTags, reqRefs and qaChecklist", () => {
    const map = loadTestMap();
    expect(map.areas.length).toBeGreaterThan(0);
    for (const area of map.areas) {
      expect(typeof area.id).toBe("string");
      expect(typeof area.title).toBe("string");
      expect(Array.isArray(area.paths)).toBe(true);
      expect(area.paths.length).toBeGreaterThan(0);
      expect(Array.isArray(area.vitest)).toBe(true);
      expect(Array.isArray(area.sql)).toBe(true);
      expect(Array.isArray(area.playwrightTags)).toBe(true);
      expect(Array.isArray(area.reqRefs)).toBe(true);
      expect(area.reqRefs.length).toBeGreaterThan(0);
      expect(Array.isArray(area.qaChecklist)).toBe(true);
      expect(area.qaChecklist.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate area ids", () => {
    const map = loadTestMap();
    const ids = map.areas.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("docs/TEST_MAP.md has no duplicate area headings", () => {
    const ids = areaIdsInMarkdown(ROOT);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("areasForFile", () => {
  it("matches a file against every area whose paths glob it, using an injected readFile", () => {
    const map = loadTestMap();
    const areas = areasForFile(map, "src/features/requests/components/RequestForm.tsx");
    // RequestForm.tsx is the documented shared fan-out row.
    expect(areas.has("request-form")).toBe(true);
    expect(areas.has("quick-request")).toBe(true);
    expect(areas.has("waitlist")).toBe(true);
  });

  it("matches src/solver/** against solver, board and publication", () => {
    const map = loadTestMap();
    const areas = areasForFile(map, "src/solver/index.ts");
    expect(areas.has("solver")).toBe(true);
    expect(areas.has("board")).toBe(true);
    expect(areas.has("publication")).toBe(true);
  });

  it("returns an empty set for a file that belongs to no area", () => {
    const map = loadTestMap();
    const areas = areasForFile(map, "README.md");
    expect(areas.size).toBe(0);
  });

  it("applies migrationContentRules by content, regardless of filename", () => {
    const map = loadTestMap();
    const readFile = (filePath) => {
      if (filePath === "supabase/migrations/20990101000000_some_unrelated_name.sql") {
        return "create or replace view v_board_rides as select 1;";
      }
      return null;
    };
    const areas = areasForFile(
      map,
      "supabase/migrations/20990101000000_some_unrelated_name.sql",
      { readFile },
    );
    expect(areas.has("board")).toBe(true);
    expect(areas.has("siddur")).toBe(true);
    expect(areas.has("ride-passengers")).toBe(true);
    expect(areas.has("publication")).toBe(true);
  });

  it("does not apply migrationContentRules to non-migration files", () => {
    const map = loadTestMap();
    const readFile = () => "enqueue_notification";
    const areas = areasForFile(map, "src/lib/time.ts", { readFile });
    expect(areas.has("notifications")).toBe(false);
  });
});

describe("isIgnored", () => {
  it("ignores generic docs and tooling files, not app source", () => {
    const map = loadTestMap();
    expect(isIgnored(map, "docs/REQUIREMENTS.md")).toBe(true);
    expect(isIgnored(map, "CLAUDE.md")).toBe(true);
    expect(isIgnored(map, "test-map.json")).toBe(true);
    expect(isIgnored(map, "e2e/helpers.ts")).toBe(true);
    expect(isIgnored(map, "src/features/requests/api.ts")).toBe(false);
    expect(isIgnored(map, "e2e/board.spec.ts")).toBe(false);
  });
});
