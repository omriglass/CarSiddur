import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TimeField15, formatMinutes, parseHHMM, snapToQuarterHour } from "./TimeField15";

describe("parseHHMM", () => {
  it("parses well-formed HH:MM", () => {
    expect(parseHHMM("08:30")).toBe(8 * 60 + 30);
    expect(parseHHMM("23:45")).toBe(23 * 60 + 45);
  });

  it("rejects malformed input", () => {
    expect(parseHHMM("8:3")).toBeNull();
    expect(parseHHMM("25:00")).toBeNull();
    expect(parseHHMM("12:60")).toBeNull();
    expect(parseHHMM("abc")).toBeNull();
  });
});

describe("formatMinutes", () => {
  it("pads to HH:MM", () => {
    expect(formatMinutes(5 * 60)).toBe("05:00");
    expect(formatMinutes(9 * 60 + 5)).toBe("09:05");
  });
});

describe("snapToQuarterHour", () => {
  it("rounds down within 7 minutes", () => {
    expect(snapToQuarterHour("08:07")).toBe("08:00");
  });

  it("rounds up at 8 minutes", () => {
    expect(snapToQuarterHour("08:08")).toBe("08:15");
  });

  it("rounds to the nearest of the four marks", () => {
    expect(snapToQuarterHour("08:22")).toBe("08:15");
    expect(snapToQuarterHour("08:23")).toBe("08:30");
    expect(snapToQuarterHour("08:37")).toBe("08:30");
    expect(snapToQuarterHour("08:38")).toBe("08:45");
  });

  it("clamps to the default 06:00–23:45 grid", () => {
    expect(snapToQuarterHour("00:00")).toBe("06:00");
    expect(snapToQuarterHour("23:59")).toBe("23:45");
  });

  it("preserves the explicit same-day endpoint for end fields", () => {
    expect(snapToQuarterHour("23:59", { max: 1439 })).toBe("23:59");
    expect(snapToQuarterHour("23:59")).toBe("23:45");
  });

  it("clamps to custom bounds", () => {
    expect(snapToQuarterHour("06:00", { min: 8 * 60, max: 20 * 60 })).toBe("08:00");
    expect(snapToQuarterHour("22:00", { min: 8 * 60, max: 20 * 60 })).toBe("20:00");
  });

  it("returns null for unparsable input", () => {
    expect(snapToQuarterHour("not a time")).toBeNull();
  });
});

describe("typed time entry", () => {
  it("keeps an editable text input inside the popover trigger and commits snapped text", () => {
    const onChange = vi.fn();
    render(<TimeField15 value="08:00" onChange={onChange} aria-label="time" />);
    const input = screen.getByLabelText("time");
    expect(input).toHaveAttribute("type", "text");
    fireEvent.change(input, { target: { value: "09:22" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("09:15");
  });

  it("places minutes on the RTL starting edge of the picker", () => {
    render(<TimeField15 value="08:00" onChange={vi.fn()} aria-label="time" />);
    fireEvent.click(screen.getByLabelText("time"));
    expect(screen.getAllByRole("listbox").map((list) => list.getAttribute("aria-label"))).toEqual(["דקות", "שעה"]);
  });
});
