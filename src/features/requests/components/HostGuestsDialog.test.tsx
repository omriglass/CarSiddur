import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import type { HostGuestQuestion } from "../api";
import { TAP_LOCK_MS } from "@/components/useTapLock";

import { HostGuestsDialog } from "./HostGuestsDialog";

const far: HostGuestQuestion = {
  request_id: "g1", name: "דנה", kind: "far", reason: null,
  wanted_at: "2026-11-20T06:00:00Z", ride_at: "2026-11-20T13:00:00Z",
};
const cannot: HostGuestQuestion = { request_id: "g2", name: "יוסי", kind: "cannot", reason: "seats", wanted_at: null, ride_at: null };

describe("HostGuestsDialog (R20 Q2 redo)", () => {
  it("asks about a far guest with both times: keep, back to waiting, or back", () => {
    const onAnswered = vi.fn();
    const onBack = vi.fn();
    render(<HostGuestsDialog guests={[far]} onAnswered={onAnswered} onBack={onBack} />);
    expect(screen.getByText(he.request.hostGuestTitle)).toBeInTheDocument();
    expect(screen.getByText(tv("request.hostGuestFarBody", { name: "דנה", wanted: "08:00", ride: "15:00" }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestKeep", { name: "דנה" }) }));
    expect(onAnswered).toHaveBeenCalledWith({ g1: "keep" });
  });

  it("sends a far guest back to the waiting list, and 'back' saves nothing", () => {
    const onAnswered = vi.fn();
    const onBack = vi.fn();
    const { rerender } = render(<HostGuestsDialog guests={[far]} onAnswered={onAnswered} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestRelease", { name: "דנה" }) }));
    expect(onAnswered).toHaveBeenCalledWith({ g1: "release" });
    rerender(<HostGuestsDialog guests={[{ ...far }]} onAnswered={onAnswered} onBack={onBack} />);
    fireEvent.click(screen.getByRole("button", { name: he.request.hostGuestBack }));
    expect(onBack).toHaveBeenCalled();
  });

  it("says why a guest cannot stay and offers only 'save anyway', one guest at a time", () => {
    vi.useFakeTimers();
    const onAnswered = vi.fn();
    render(<HostGuestsDialog guests={[far, cannot]} onAnswered={onAnswered} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestKeep", { name: "דנה" }) }));
    expect(onAnswered).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(TAP_LOCK_MS); });   // one double tap never answers two guests
    expect(screen.getByText(tv("request.hostGuestCannotBody", { name: "יוסי", reason: he.request.hostGuestReason.seats }))).toBeInTheDocument();
    expect(screen.queryByTestId("host-guest-release")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.request.hostGuestSaveAnyway }));
    expect(onAnswered).toHaveBeenCalledWith({ g1: "keep", g2: "release" });
    vi.useRealTimers();
  });
});
