import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";

import { describeStatusReason } from "./statusReason";

describe("describeStatusReason", () => {
  it("returns the Hebrew label for a known code", () => {
    expect(describeStatusReason("UNMET_NEEDS_DRIVER")).toBe(he.statusReason.UNMET_NEEDS_DRIVER);
  });

  it("returns null for a missing code", () => {
    expect(describeStatusReason(null)).toBeNull();
    expect(describeStatusReason(undefined)).toBeNull();
  });

  it("falls back to the generic Hebrew label — never the raw code — for an unknown code", () => {
    const result = describeStatusReason("SOME_FUTURE_CODE_NOT_YET_MIRRORED");
    expect(result).toBe(he.statusReasonUnknown);
    expect(result).not.toContain("SOME_FUTURE_CODE_NOT_YET_MIRRORED");
  });
});
