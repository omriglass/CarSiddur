import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { DEFAULT_TIRE_STATES } from "../schema";
import { TireFillPanel } from "./TireFillPanel";

describe("TireFillPanel", () => {
  it("cycles a single tire ok → low → very_low → ok without touching the others", () => {
    let tires = DEFAULT_TIRE_STATES;
    const onChange = vi.fn((next: typeof tires) => {
      tires = next;
    });
    const { rerender } = render(
      <TireFillPanel value={tires} onChange={onChange} note="" onNoteChange={vi.fn()} />,
    );

    const frontLeft = screen.getByLabelText(`${he.carCare.tirePosition.front_left} — ${he.carCare.tireLegendOk}`);
    fireEvent.click(frontLeft);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TIRE_STATES, front_left: "low" });

    rerender(<TireFillPanel value={tires} onChange={onChange} note="" onNoteChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(`${he.carCare.tirePosition.front_left} — ${he.carCare.tireLegendLow}`));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TIRE_STATES, front_left: "very_low" });

    rerender(<TireFillPanel value={tires} onChange={onChange} note="" onNoteChange={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(`${he.carCare.tirePosition.front_left} — ${he.carCare.tireLegendVeryLow}`));
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_TIRE_STATES, front_left: "ok" });

    // The other four positions are untouched throughout (payload shape stays complete: all
    // five keys present on every call, `cycleTireState` only ever changes the tapped one).
    for (const call of onChange.mock.calls) {
      const [next] = call as [typeof tires];
      expect(Object.keys(next).sort()).toEqual(["front_left", "front_right", "rear_left", "rear_right", "spare"]);
      expect(next.front_right).toBe("ok");
      expect(next.rear_left).toBe("ok");
      expect(next.rear_right).toBe("ok");
      expect(next.spare).toBe("ok");
    }
  });

  it("renders all five tire positions and the three-state legend", () => {
    render(<TireFillPanel value={DEFAULT_TIRE_STATES} onChange={vi.fn()} note="" onNoteChange={vi.fn()} />);
    for (const position of ["front_left", "front_right", "rear_left", "rear_right", "spare"] as const) {
      expect(screen.getByLabelText(`${he.carCare.tirePosition[position]} — ${he.carCare.tireLegendOk}`)).toBeInTheDocument();
    }
    expect(screen.getByText(he.carCare.tireLegendOk)).toBeInTheDocument();
    expect(screen.getByText(he.carCare.tireLegendLow)).toBeInTheDocument();
    expect(screen.getByText(he.carCare.tireLegendVeryLow)).toBeInTheDocument();
  });

  it("reports the note through onNoteChange", () => {
    const onNoteChange = vi.fn();
    render(<TireFillPanel value={DEFAULT_TIRE_STATES} onChange={vi.fn()} note="" onNoteChange={onNoteChange} />);
    fireEvent.change(screen.getByLabelText(he.carCare.tireNoteLabel), { target: { value: "front tire looked worn" } });
    expect(onNoteChange).toHaveBeenCalledWith("front tire looked worn");
  });
});
