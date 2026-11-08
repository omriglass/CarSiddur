import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { RideEditorsCardView } from "./RideEditorsCard";

const members = [{ id: "a", name: "אגתה" }, { id: "b", name: "בני" }];

describe("RideEditorsCardView (REQ §13.202)", () => {
  it("shows no save button until the list changes, then saves the whole list", () => {
    const onSave = vi.fn();
    render(<RideEditorsCardView members={members} saved={["a", "b"]} grantedToMe={[]} saving={false} onSave={onSave} />);
    expect(screen.queryByTestId("ride-editors-save")).toBeNull();
    expect(screen.queryByTestId("ride-editors-granted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "אגתה ×" }));
    fireEvent.click(screen.getByTestId("ride-editors-save"));
    expect(onSave).toHaveBeenCalledWith(["b"]);
  });

  it("lists the people who let me edit theirs, read-only", () => {
    render(<RideEditorsCardView members={members} saved={[]} saving={false} onSave={vi.fn()}
      grantedToMe={[{ departmentId: "d", person: { id: "c", name: "כרמל" } }]} />);
    expect(screen.getByTestId("ride-editors-granted")).toHaveTextContent(he.profileExtra.rideEditorsGrantedTitle);
    expect(screen.getByTestId("ride-editors-granted")).toHaveTextContent("כרמל");
  });
});
