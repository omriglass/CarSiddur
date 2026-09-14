import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { he, tv } from "@/i18n/he";

import type { SharingStat } from "../types";
import { SharingTile } from "./SharingTile";

const sharing: SharingStat = {
  peopleUtilization: 0.6,
  fragmentation: 1.5,
  fragmentationRideCount: 3,
  activeCarDays: 2,
  oneWayFulfilment: 0.6667,
  oneWayServed: 2,
  oneWayTotal: 3,
};

describe("SharingTile", () => {
  it("renders all three numbers with their captions and raw-count subtitles", () => {
    render(<SharingTile sharing={sharing} />);
    expect(screen.getByTestId("stats-sharing-people-utilization")).toHaveTextContent("60.0%");
    expect(screen.getByTestId("stats-sharing-people-utilization")).toHaveTextContent(he.stats.sharing.peopleUtilization);

    expect(screen.getByTestId("stats-sharing-fragmentation")).toHaveTextContent("1.5");
    expect(screen.getByTestId("stats-sharing-fragmentation")).toHaveTextContent(
      tv("stats.sharing.fragmentationSub", { rides: "3", days: "2" }),
    );

    expect(screen.getByTestId("stats-sharing-one-way")).toHaveTextContent("66.7%");
    expect(screen.getByTestId("stats-sharing-one-way")).toHaveTextContent(
      tv("stats.sharing.oneWaySub", { served: "2", total: "3" }),
    );
  });
});
