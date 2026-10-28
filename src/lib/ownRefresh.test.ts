import { afterEach, describe, expect, it } from "vitest";

import { noteOwnRefresh, OWN_REFRESH_WINDOW_MS, refreshedRecently, resetOwnRefresh } from "./ownRefresh";

describe("ownRefresh", () => {
  afterEach(resetOwnRefresh);

  it("counts a refresh of the same department-week within the window only", () => {
    noteOwnRefresh("d", "2026-11-01", 1_000);
    expect(refreshedRecently("d", "2026-11-01", 1_000 + OWN_REFRESH_WINDOW_MS)).toBe(true);
    expect(refreshedRecently("d", "2026-11-01", 1_001 + OWN_REFRESH_WINDOW_MS)).toBe(false);
    expect(refreshedRecently("d", "2026-11-08", 1_000)).toBe(false);
    expect(refreshedRecently("e", "2026-11-01", 1_000)).toBe(false);
  });
});
