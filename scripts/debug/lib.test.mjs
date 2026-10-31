import { describe, expect, it } from "vitest";

import { debugConfig, firstJsonObject, selectedWeeks, weekStartOf } from "./lib.mjs";

describe("debug copy helpers", () => {
  it("weeks start on the Asia/Jerusalem Sunday", () => {
    expect(weekStartOf(new Date("2026-10-31T17:00:00Z"))).toBe("2026-10-25");
    // 00:30 on Sunday in Israel is still Saturday in UTC.
    expect(weekStartOf(new Date("2026-10-31T22:30:00Z"))).toBe("2026-11-01");
    expect(weekStartOf(new Date("2026-10-28T12:00:00Z"), -1)).toBe("2026-10-18");
  });

  it("picks the weeks relative to the pull time", () => {
    const pulled = "2026-10-29T10:00:00Z";
    expect(selectedWeeks({}, pulled)).toEqual(["2026-10-25", "2026-11-01"]);
    expect(selectedWeeks({ withPrevious: true }, pulled)).toEqual(["2026-10-18", "2026-10-25", "2026-11-01"]);
    expect(selectedWeeks({ week: "this" }, pulled)).toEqual(["2026-10-25"]);
    expect(selectedWeeks({ week: "next" }, pulled)).toEqual(["2026-11-01"]);
    expect(selectedWeeks({ week: "this", withPrevious: true }, pulled)).toEqual(["2026-10-18", "2026-10-25"]);
    expect(selectedWeeks({ week: "2026-10-14" }, pulled)).toEqual(["2026-10-11"]);
    expect(selectedWeeks({ all: true }, pulled)).toBeNull();
    expect(() => selectedWeeks({ week: "soon" }, pulled)).toThrow(/--week/);
  });

  it("reads the first JSON object of CLI output", () => {
    expect(firstJsonObject('noise {"rows":[{"a":"}"}]}\n{"other":1}').rows).toEqual([{ a: "}" }]);
  });

  it("moves every port to 6073x and turns the seed off", () => {
    const config = 'project_id = "carshare-nevo"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[db.seed]\nenabled = true\n[auth]\nsite_url = "http://localhost:8080"\nadditional_redirect_urls = ["http://localhost:8080"]\n';
    const out = debugConfig(config, { projectId: "carshare-debug", appUrl: "http://localhost:6073" });
    expect(out).toContain('project_id = "carshare-debug"');
    expect(out).toContain("port = 60731");
    expect(out).toContain("port = 60732");
    expect(out).toContain("shadow_port = 60730");
    expect(out).toMatch(/\[db\.seed\]\nenabled = false/);
    expect(out).toContain('site_url = "http://localhost:6073"');
    expect(out).not.toContain("5432");
  });
});
