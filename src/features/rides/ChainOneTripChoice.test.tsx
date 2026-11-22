import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { tv } from "@/i18n/he";

import { ChainOneTripChoice } from "./ChainOneTripChoice";
import { oneTripNames, parseChain } from "./mergeChain";

// CM1 phase 3 (REQ item 260 c): the chain's people on one trip only - the whole ride, or pass the start place again.
const route = (names: string[], back: string[]) => [
  ...names.map((name) => ({ leg: "out", place_id: name, name })), ...back.map((name) => ({ leg: "return", place_id: name, name }))];
const raw = {
  side: "before", request_id: "qa", base_request_id: "qb",
  route: route(["נבו", "בית ספר", "חיפה"], ["חיפה", "נבו"]),
  one_trip: {
    names: ["דנה"], unnamed: 0, place: "נבו", was: "2041-03-04T06:30:00Z", via_chosen: false,
    plain: { route: route(["נבו", "בית ספר", "חיפה"], ["חיפה", "נבו"]), at: "2041-03-04T05:45:00Z", ok: true },
    via: { route: route(["נבו", "בית ספר", "נבו", "חיפה"], ["חיפה", "נבו"]), at: "2041-03-04T06:20:00Z", ok: true },
  },
};

describe("chain one-trip question", () => {
  it("parses both answers and the side", () => {
    const chain = parseChain(raw)!;
    expect(chain.oneTrip).toMatchObject({ names: ["דנה"], place: "נבו", plain: { ok: true }, via: { ok: true } });
    expect(parseChain({ ...raw, side: "before_via" })?.side).toBe("before_via");
    expect(parseChain({ ...raw, one_trip: null })?.oneTrip).toBeNull();
  });

  it("names the unnamed too", () => {
    expect(oneTripNames({ names: ["דנה"], unnamed: 2 })).toContain(tv("mergedRide.chainMore", { count: "2" }));
  });

  it("shows each answer's route and picks one", () => {
    const chain = parseChain(raw)!;
    const onChange = vi.fn();
    render(<ChainOneTripChoice chain={{ side: chain.side, oneTrip: chain.oneTrip! }} via={false} onChange={onChange} />);
    expect(screen.getByTestId("chain-one-trip-plain")).toHaveTextContent(tv("mergedRide.chainWhole", { route: "נבו ← בית ספר ← חיפה ← נבו" }));
    expect(screen.getByTestId("chain-one-trip-via")).toHaveTextContent(tv("mergedRide.chainPickUp", { place: "נבו", route: "נבו ← בית ספר ← נבו ← חיפה ← נבו" }));
    expect(screen.getByTestId("chain-one-trip-plain")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("chain-one-trip-via"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("their time is on the 15-minute grid (R22U6)", () => {
    const chain = parseChain(raw)!;
    render(<ChainOneTripChoice chain={{ side: chain.side, oneTrip: chain.oneTrip! }} via={false} onChange={vi.fn()} />);
    // 08:20 -> 08:15; asked 08:30
    expect(screen.getByTestId("chain-one-trip-via")).toHaveTextContent(tv("mergedRide.chainTimeBefore", { time: "08:15", was: "08:30" }));
  });

  it("an answer over the detour limit is offered with a warning", () => {
    const chain = parseChain({ ...raw, one_trip: { ...raw.one_trip, via: { ...raw.one_trip.via, ok: false, added_minutes: 25 } } })!;
    const onChange = vi.fn();
    render(<ChainOneTripChoice chain={{ side: chain.side, oneTrip: chain.oneTrip! }} via={false} onChange={onChange} />);
    expect(screen.getByTestId("chain-one-trip-via")).toBeEnabled();
    expect(screen.getByTestId("chain-one-trip-long")).toHaveTextContent("25");
    fireEvent.click(screen.getByTestId("chain-one-trip-via"));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
