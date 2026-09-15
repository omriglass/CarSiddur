import { describe, expect, it } from "vitest";

import { destinationLabelKey } from "./destinationLabel";

describe("destinationLabelKey", () => {
  it("asks 'where from' only for a return-only request", () => {
    expect(destinationLabelKey("one_way_from")).toBe("field.destinationFrom");
  });

  it("asks 'where to' for round trips, outbound-only and an unset shape", () => {
    expect(destinationLabelKey("round_trip")).toBe("field.destination");
    expect(destinationLabelKey("one_way_to")).toBe("field.destination");
    expect(destinationLabelKey(undefined)).toBe("field.destination");
  });
});
