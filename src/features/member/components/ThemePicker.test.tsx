import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { he } from "@/i18n/he";
import { ThemePicker } from "./ThemePicker";

describe("ThemePicker", () => {
  beforeEach(() => localStorage.clear());

  it("lists every theme plus custom as radios and stores the choice", () => {
    render(<ThemePicker />);
    expect(screen.getAllByRole("radio").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId("theme-option-custom")).toHaveTextContent(he.themes.names.custom);
    fireEvent.click(screen.getByTestId("theme-option-custom"));
    expect(localStorage.getItem("nevo-theme-id.v1")).toBe("custom");
    expect(screen.getByTestId("theme-option-custom")).toHaveAttribute("aria-checked", "true");
  });

  it("shows the editor only for custom and flags an unreadable pick", () => {
    render(<ThemePicker />);
    expect(screen.queryByTestId("custom-theme-editor")).toBeNull();
    fireEvent.click(screen.getByTestId("theme-option-custom"));
    expect(screen.getByTestId("custom-theme-editor")).toBeInTheDocument();
    expect(screen.queryByText(he.themes.custom.adjusted)).toBeNull();
    fireEvent.click(screen.getByTestId("custom-theme-light-role-primary"));
    fireEvent.click(screen.getByTestId("custom-theme-light-role-background"));
    fireEvent.change(screen.getByTestId("custom-theme-light-background"), { target: { value: "#ffffff" } });
    fireEvent.click(screen.getByTestId("custom-theme-light-role-primary"));
    fireEvent.change(screen.getByTestId("custom-theme-light-primary"), { target: { value: "#ffff00" } });
    expect(screen.getByTestId("custom-theme-light-primary-adjusted")).toHaveTextContent(he.themes.custom.adjusted);
  });

  it("a role chip plus a swatch changes only that seed and stores it", () => {
    render(<ThemePicker />);
    fireEvent.click(screen.getByTestId("theme-option-custom"));
    fireEvent.click(screen.getByTestId("custom-theme-light-role-card"));
    fireEvent.click(screen.getByTestId("custom-theme-light-card-swatch-dbeafe"));
    const stored = JSON.parse(localStorage.getItem("nevo-theme-custom.v1") ?? "{}");
    expect(stored.light.card).toBe("#dbeafe");
    expect(stored.light.primary).not.toBe("#dbeafe");
  });
});
