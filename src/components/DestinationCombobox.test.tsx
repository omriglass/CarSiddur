import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SheetPortalContext } from "./SheetPortalContext";
import { DestinationCombobox, filterDestinations, type DestinationPreset } from "./DestinationCombobox";

// jsdom has no `Element.scrollIntoView` (`cmdk`'s own item-selection layout effect calls it as
// soon as the command list mounts); same jsdom-gap pattern as `src/test/setup.ts`'s
// `ResizeObserver` stub, scoped to this file since nothing else here renders `cmdk`.
Element.prototype.scrollIntoView ??= () => {};

const DESTINATIONS: DestinationPreset[] = [
  { id: "1", name: "עפולה", aliases: ["מרפאת כללית"], zone: "north" },
  { id: "2", name: "חיפה", aliases: [], zone: "haifa" },
  { id: "3", name: "תל אביב", aliases: ["ת\"א"], zone: "tel_aviv" },
];

describe("filterDestinations", () => {
  it("returns everything for an empty query", () => {
    expect(filterDestinations(DESTINATIONS, "")).toHaveLength(3);
  });

  it("matches by name", () => {
    expect(filterDestinations(DESTINATIONS, "עפולה").map((d) => d.id)).toEqual(["1"]);
  });

  it("matches by alias", () => {
    expect(filterDestinations(DESTINATIONS, "מרפאת").map((d) => d.id)).toEqual(["1"]);
  });

  it("matches by zone", () => {
    expect(filterDestinations(DESTINATIONS, "haifa").map((d) => d.id)).toEqual(["2"]);
  });

  it("is case-insensitive for latin zones", () => {
    expect(filterDestinations(DESTINATIONS, "HAIFA").map((d) => d.id)).toEqual(["2"]);
  });

  it("returns no presets for an unmatched query (free text still offered by the component)", () => {
    expect(filterDestinations(DESTINATIONS, "משהו שלא קיים")).toHaveLength(0);
  });
});

describe("popover portal container", () => {
  // Same nested-scroll fix as `TimeField15.test.tsx`: a modal Sheet/Dialog only allows
  // touch-scroll within its own content subtree (`react-remove-scroll`); portaling to
  // `document.body` (the default) makes this popover's own scrollable results list a DOM
  // *sibling* instead of a descendant, which silently breaks its touch-scroll.
  // `SheetPortalContext` fixes that by portaling into the ancestor's own node instead —
  // assert the popover actually lands there.
  it("portals into the DOM node given by SheetPortalContext instead of document.body", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(
      <SheetPortalContext.Provider value={container}>
        <DestinationCombobox destinations={DESTINATIONS} value={null} onChange={vi.fn()} autoFocus />
      </SheetPortalContext.Provider>,
    );
    expect(container.querySelector("[cmdk-input]")).not.toBeNull();
    document.body.removeChild(container);
  });

  it("falls back to portaling into document.body when no context is provided", () => {
    render(<DestinationCombobox destinations={DESTINATIONS} value={null} onChange={vi.fn()} autoFocus />);
    expect(document.body.querySelector("[cmdk-input]")).not.toBeNull();
  });
});
