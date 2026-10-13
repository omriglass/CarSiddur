import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SheetPortalContext } from "./SheetPortalContext";
import { TimeField15 } from "./TimeField15";
import { formatMinutes, normalizeTypedTime, parseHHMM, snapToQuarterHour } from "./timeField15Format";

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

describe("inside a sheet or dialog", () => {
  // A modal Sheet/Dialog clips a popover and blocks its touch-scroll, so with `SheetPortalContext` the
  // lists open inline under the input (the sheet grows only while open).
  it("opens the hour/minute lists inline, not in a portal, and toggles on click", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const { container: root } = render(
      <SheetPortalContext.Provider value={container}>
        <TimeField15 value="08:00" onChange={vi.fn()} aria-label="time" />
      </SheetPortalContext.Provider>,
    );
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("time"));
    expect(root.querySelector('[role="listbox"][aria-label="שעה"]')).not.toBeNull();
    expect(container.querySelector('[role="listbox"]')).toBeNull();
    fireEvent.click(screen.getByLabelText("time"));
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
    document.body.removeChild(container);
  });

  it("picks an hour inline", () => {
    const onChange = vi.fn();
    render(
      <SheetPortalContext.Provider value={document.body}>
        <TimeField15 value="08:00" onChange={onChange} aria-label="time" />
      </SheetPortalContext.Provider>,
    );
    fireEvent.click(screen.getByLabelText("time"));
    fireEvent.click(screen.getByRole("button", { name: "22" }));
    expect(onChange).toHaveBeenCalledWith("22:00");
  });
  it("keeps the lists open when Safari moves focus to the sheet itself, so the tapped hour still commits", () => {
    // Safari never focuses a tapped <button>: the input's blur names the nearest focusable ancestor instead.
    const onChange = vi.fn();
    const sheet = document.createElement("div");
    sheet.tabIndex = -1;
    document.body.appendChild(sheet);
    render(
      <SheetPortalContext.Provider value={sheet}>
        <TimeField15 value="08:00" onChange={onChange} aria-label="time" />
      </SheetPortalContext.Provider>,
      { container: sheet },
    );
    const input = screen.getByLabelText("time");
    fireEvent.click(input);
    fireEvent.blur(input, { relatedTarget: sheet });
    fireEvent.click(screen.getByRole("button", { name: "10" }));
    expect(onChange).toHaveBeenLastCalledWith("10:00");
    document.body.removeChild(sheet);
  });

  it("closes the lists when focus moves to another field", () => {
    const other = document.createElement("input");
    document.body.appendChild(other);
    render(
      <SheetPortalContext.Provider value={document.body}>
        <TimeField15 value="08:00" onChange={vi.fn()} aria-label="time" />
      </SheetPortalContext.Provider>,
    );
    const input = screen.getByLabelText("time");
    fireEvent.click(input);
    fireEvent.blur(input, { relatedTarget: other });
    expect(screen.queryAllByRole("listbox")).toHaveLength(0);
    document.body.removeChild(other);
  });

  it("commits a time typed on the iPhone number pad (no colon)", () => {
    const onChange = vi.fn();
    render(
      <SheetPortalContext.Provider value={document.body}>
        <TimeField15 value="08:00" onChange={onChange} aria-label="time" />
      </SheetPortalContext.Provider>,
    );
    const input = screen.getByLabelText("time");
    fireEvent.change(input, { target: { value: "1145" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith("11:45");
  });
});

describe("normalizeTypedTime", () => {
  it("reads digits alone and . or , as the colon", () => {
    expect(normalizeTypedTime("9")).toBe("9:00");
    expect(normalizeTypedTime("17")).toBe("17:00");
    expect(normalizeTypedTime("930")).toBe("9:30");
    expect(normalizeTypedTime("0930")).toBe("09:30");
    expect(normalizeTypedTime("9.30")).toBe("9:30");
    expect(normalizeTypedTime("9,30")).toBe("9:30");
    expect(normalizeTypedTime(" 08:15 ")).toBe("08:15");
  });

  it("leaves anything else for parseHHMM to reject", () => {
    expect(snapToQuarterHour(normalizeTypedTime("12345"))).toBeNull();
    expect(snapToQuarterHour(normalizeTypedTime("abc"))).toBeNull();
    expect(snapToQuarterHour(normalizeTypedTime("2560"))).toBeNull();
  });
});

describe("popover outside a sheet", () => {
  it("portals into document.body when no context is provided", () => {
    render(<TimeField15 value="08:00" onChange={vi.fn()} aria-label="time" />);
    fireEvent.click(screen.getByLabelText("time"));
    expect(document.body.querySelector('[role="listbox"][aria-label="שעה"]')).not.toBeNull();
  });
});

describe("TimeField15 hour list pick (inline in a sheet)", () => {
  it("a re-render (blur-commit before a tap) does not snap the list back to the selected hour, and the tapped hour is committed", () => {
    const offsetTop = vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockReturnValue(500);
    try {
      const onChange = vi.fn();
      const { container } = render(
        <SheetPortalContext.Provider value={document.body}>
          <TimeField15 value="12:00" onChange={onChange} aria-label="t" />
        </SheetPortalContext.Provider>,
      );
      const input = container.querySelector("input") as HTMLInputElement;
      fireEvent.click(input);
      const list = screen.getByTestId("time-hour-list");
      expect(list.scrollTop).toBe(456); // opens on the selected hour
      list.scrollTop = 0; // the user scrolled up to 09
      fireEvent.blur(input); // pointer-down on 09 blurs the input and re-renders
      expect(list.scrollTop).toBe(0);
      fireEvent.click(screen.getByRole("button", { name: "09" }));
      expect(onChange).toHaveBeenLastCalledWith("09:00");
    } finally {
      offsetTop.mockRestore();
    }
  });
});
