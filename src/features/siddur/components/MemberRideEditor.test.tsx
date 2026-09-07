import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { he } from "@/i18n/he";
import type { BoardRide } from "../api";
import type { Car } from "@/features/fleet/api";
import { MemberRideEditor } from "./MemberRideEditor";

afterEach(cleanup);

it("allows a ride ending at next midnight to retain that endpoint when edited", () => {
  const save = vi.fn();
  render(<MemberRideEditor ride={{ id: "ride", car_id: "car", version: 1, starts_at: "2041-01-06T20:00:00Z", ends_at: "2041-01-06T22:00:00Z" } as BoardRide}
    cars={[{ id: "car", name: "Car", status: "active", type: "shared" } as Car]} saving={false} onSave={save} />);
  expect(screen.getByLabelText(he.field.return)).toHaveValue("00:00");
  expect(screen.getByRole("button", { name: he.common.save })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: he.common.save }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ startsAt: "2041-01-06T20:00:00.000Z", endsAt: "2041-01-06T22:00:00.000Z" }));
});
