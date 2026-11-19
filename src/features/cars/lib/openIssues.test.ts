import { describe, expect, it } from "vitest";

import { countByCar } from "./openIssues";

describe("countByCar", () => {
  it("counts open issues per car", () => {
    expect([...countByCar([{ car_id: "a" }, { car_id: "b" }, { car_id: "a" }])]).toEqual([["a", 2], ["b", 1]]);
  });
});
