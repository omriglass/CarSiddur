import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TripSummary } from "./TripSummary";
import { he } from "@/i18n/he";

describe("TripSummary", () => {
  it("identifies a trip with its purpose, Hebrew weekday, date and Jerusalem hours", () => {
    const { container } = render(<TripSummary name="Adi" destination="Binyamina" purpose="Errands"
      departAt="2026-09-09T07:00:00Z" returnAt="2026-09-09T12:00:00Z" />);
    expect(screen.getByText("Adi · Binyamina")).toBeInTheDocument();
    expect(container).toHaveTextContent(`${he.days.short[3]}${he.days.geresh} 9.9 · 10:00–15:00 · Errands`);
  });

  it("uses the arrival's local date and return label for a return-only trip", () => {
    const { container } = render(<TripSummary destination="Train" departAt={null} returnAt="2026-09-09T22:00:00Z" />);
    expect(container).toHaveTextContent(`${he.days.short[4]}${he.days.geresh} 10.9 · ${he.field.return} 01:00`);
    expect(container).not.toHaveTextContent(he.field.depart);
  });

  it("keeps both dates visible when a trip crosses midnight", () => {
    const { container } = render(<TripSummary destination="Binyamina"
      departAt="2026-09-09T20:00:00Z" returnAt="2026-09-09T22:00:00Z" />);
    expect(container).toHaveTextContent(`${he.days.short[3]}${he.days.geresh} 9.9 · 23:00–${he.days.short[4]}${he.days.geresh} 10.9 01:00`);
  });
});
