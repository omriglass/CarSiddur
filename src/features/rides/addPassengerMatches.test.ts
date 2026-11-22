import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/rpc";

import { mergeRefusalOf, withMerges, withoutMerge } from "./addPassengerMatches";

describe("addPassengerMatches (PS1)", () => {
  it("reads the merge_refused detail; other errors are not refusals", () => {
    const error = new AppError("merge_refused", "x", undefined, JSON.stringify({ person_id: "m1", name: "נעמה", code: "detour", needs: null }));
    expect(mergeRefusalOf(error)).toEqual({ personId: "m1", name: "נעמה", code: "detour", needs: [] });
    expect(mergeRefusalOf(new AppError("person_busy", "x", undefined, "{}"))).toBeNull();
    expect(mergeRefusalOf(new Error("x"))).toBeNull();
  });
  it("sends a request along only for a yes, and drops it again on a refusal", () => {
    const rows = [{ person_id: "m1", display_name: "א", seat_kind: "adult" as const }, { person_id: "m2", display_name: "ב", seat_kind: "adult" as const }];
    const merged = withMerges(rows, new Map([["m1", "q1"]]));
    expect(merged.map((row) => row.merge_request_id)).toEqual(["q1", undefined]);
    expect(withoutMerge(merged, "m1")[0]).not.toHaveProperty("merge_request_id");
  });
});
