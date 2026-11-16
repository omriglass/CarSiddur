import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import type { HostGuestQuestion } from "../api";
import { TAP_LOCK_MS } from "@/components/useTapLock";

import { HostGuestsDialog } from "./HostGuestsDialog";

const far: HostGuestQuestion = {
  request_id: "g1", name: "דנה", kind: "warn", warnings: ["far"], reason: null,
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

  it("R21U1: a far return is asked about as the return", () => {
    render(<HostGuestsDialog guests={[{ ...far, end: "return" }]} onAnswered={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText(tv("request.hostGuestFarBodyReturn", { name: "דנה", wanted: "08:00", ride: "15:00" }))).toBeInTheDocument();
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
    expect(screen.getByText(tv("request.hostGuestSeatsBody", { name: "יוסי" }))).toBeInTheDocument();
    expect(screen.queryByTestId("host-guest-release")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.request.hostGuestSaveAnyway }));
    expect(onAnswered).toHaveBeenCalledWith({ g1: "keep", g2: "release" });
    vi.useRealTimers();
  });

  it("asks once per warning (detour with its minutes, then luggage); 'back to waiting' skips the guest's other questions", () => {
    vi.useFakeTimers();
    const both: HostGuestQuestion = { ...far, request_id: "g3", name: "יוסי", warnings: ["detour", "luggage"], added_minutes: 25 };
    const onAnswered = vi.fn();
    const { rerender } = render(<HostGuestsDialog guests={[both, far]} onAnswered={onAnswered} onBack={vi.fn()} />);
    expect(screen.getByText(tv("request.hostGuestDetourBody", { name: "יוסי", minutes: "25" }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestKeep", { name: "יוסי" }) }));
    act(() => { vi.advanceTimersByTime(TAP_LOCK_MS); });
    expect(screen.getByText(tv("request.hostGuestLuggageBody", { name: "יוסי" }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestKeep", { name: "יוסי" }) }));
    act(() => { vi.advanceTimersByTime(TAP_LOCK_MS); });
    fireEvent.click(screen.getByRole("button", { name: tv("request.hostGuestKeep", { name: "דנה" }) }));
    expect(onAnswered).toHaveBeenLastCalledWith({ g3: "keep", g1: "keep" });

    rerender(<HostGuestsDialog guests={[{ ...both }, far]} onAnswered={onAnswered} onBack={vi.fn()} />);
    fireEvent.click(screen.getByTestId("host-guest-release"));
    act(() => { vi.advanceTimersByTime(TAP_LOCK_MS); });
    expect(screen.getByText(tv("request.hostGuestFarBody", { name: "דנה", wanted: "08:00", ride: "15:00" }))).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("host-guest-release"));
    expect(onAnswered).toHaveBeenLastCalledWith({ g3: "release", g1: "release" });
    vi.useRealTimers();
  });
});
