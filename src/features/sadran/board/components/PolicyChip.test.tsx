import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { PolicyChip } from "./PolicyChip";
import type { PolicyOption } from "../../api";

function option(overrides: Partial<PolicyOption> = {}): PolicyOption {
  return {
    policyId: "policy-1",
    name: "מדיניות רגילה",
    policyVersionId: "version-1",
    versionNo: 3,
    rules: [],
    isActive: true,
    note: null,
    createdAt: "2026-09-01T10:00:00Z",
    ...overrides,
  };
}

describe("PolicyChip", () => {
  it("shows the current policy's name and version on the chip", () => {
    render(
      <PolicyChip policyOptions={[option()]} activePolicy={null} value="version-1" stale={false} onSelect={vi.fn()} />,
    );
    expect(screen.getByTestId("board-policy-chip")).toHaveTextContent("מדיניות רגילה");
    expect(screen.getByTestId("board-policy-chip")).toHaveTextContent("3");
  });

  it("shows the amber policy-changed badge when stale", () => {
    render(
      <PolicyChip policyOptions={[option()]} activePolicy={null} value="version-1" stale onSelect={vi.fn()} />,
    );
    expect(screen.getByText(he.board.policyChanged)).toBeInTheDocument();
  });

  it("lists every policy row with a note, falling back to the placeholder when note is empty, and marks the current one", () => {
    const withNote = option({ policyVersionId: "version-2", policyId: "policy-2", name: "מדיניות מיוחדת", note: "לשבועות חג" });
    const withoutNote = option();
    render(
      <PolicyChip policyOptions={[withNote, withoutNote]} activePolicy={null} value="version-2" stale={false} onSelect={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("board-policy-chip"));
    expect(screen.getByText("לשבועות חג")).toBeInTheDocument();
    expect(screen.getByText(he.sadranBoard.policyVersionNote)).toBeInTheDocument();
    const currentRow = screen.getByTestId("board-policy-option-version-2");
    expect(currentRow.querySelector("svg")).toBeInTheDocument();
    const otherRow = screen.getByTestId("board-policy-option-version-1");
    expect(otherRow.querySelector("svg")).toBeNull();
  });

  it("calls onSelect with the chosen version and closes the dialog", () => {
    const onSelect = vi.fn();
    render(
      <PolicyChip
        policyOptions={[option(), option({ policyVersionId: "version-2", policyId: "policy-2", name: "אחרת" })]}
        activePolicy={null}
        value="version-1"
        stale={false}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("board-policy-chip"));
    fireEvent.click(screen.getByTestId("board-policy-option-version-2"));
    expect(onSelect).toHaveBeenCalledWith("version-2");
    expect(screen.queryByTestId("board-policy-option-version-2")).not.toBeInTheDocument();
  });

  it("falls back to the active policy's name/version when the current selection isn't in the options list", () => {
    render(
      <PolicyChip
        policyOptions={[]}
        activePolicy={{ policyId: "p", name: "מדיניות פעילה", policyVersionId: "v9", versionNo: 9, rules: [] }}
        value="v9"
        stale={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByTestId("board-policy-chip")).toHaveTextContent("מדיניות פעילה");
    expect(screen.getByTestId("board-policy-chip")).toHaveTextContent("9");
  });
});
