import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { CarSwapDialog } from "./CarSwapDialog";

import type { CarSwapPreview } from "@/features/carSwap/schema";

const mocks = vi.hoisted(() => ({ mutateAsync: vi.fn().mockResolvedValue({ moved_rides: 1, notified: 0, notices: [] }) }));
let previewState: { data?: CarSwapPreview; isLoading: boolean; isError: boolean; error?: unknown } = { isLoading: false, isError: false };

vi.mock("@/features/carSwap/hooks", () => ({
  useCarSwapPreviewQuery: () => previewState,
  useCarSwapMutation: () => ({ mutateAsync: mocks.mutateAsync, isPending: false }),
}));

function preview(overrides: Partial<CarSwapPreview> = {}): CarSwapPreview {
  return { fingerprint: "fp1", rides: [], series: [], blockers: [], notices: [], can_swap: true, notify: false, ...overrides };
}

const carA = { id: "car-a", name: "יונדאי 1" };
const carB = { id: "car-b", name: "יונדאי 3" };

beforeEach(() => {
  mocks.mutateAsync.mockClear();
  previewState = { isLoading: false, isError: false };
});

describe("CarSwapDialog", () => {
  it("disables the confirm button while the preview says the swap can't go through", () => {
    previewState = { isLoading: false, isError: false, data: preview({ can_swap: false, blockers: [{ code: "seats", ride_id: null, car_id: null, detail: null }] }) };
    render(<CarSwapDialog open onOpenChange={vi.fn()} departmentId="d" weekStart="2026-09-20" day="2026-09-24" carA={carA} carB={carB} />);
    expect(screen.getByText(he.common.confirm)).toBeDisabled();
    expect(screen.getByText(he.carSwap.blockersTitle)).toBeInTheDocument();
  });

  it("enables the confirm button and submits the default 'whole' series mode when there is no series in the moved rides", async () => {
    previewState = { isLoading: false, isError: false, data: preview() };
    render(<CarSwapDialog open onOpenChange={vi.fn()} departmentId="d" weekStart="2026-09-20" day="2026-09-24" carA={carA} carB={carB} />);
    expect(screen.getByText(he.common.confirm)).not.toBeDisabled();
    fireEvent.click(screen.getByText(he.common.confirm));
    await vi.waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ carA: "car-a", carB: "car-b", day: "2026-09-24", expectedFingerprint: "fp1", seriesMode: "whole" }),
    ));
  });

  it("shows the series radio when a moved ride belongs to a multi-day series, and submits 'day' once picked", async () => {
    previewState = {
      isLoading: false,
      isError: false,
      data: preview({ series: [{ series_id: "s1", car_id: "car-a", days: ["2026-09-24"], first_day: "2026-09-24", last_day: "2026-09-27" }] }),
    };
    render(<CarSwapDialog open onOpenChange={vi.fn()} departmentId="d" weekStart="2026-09-20" day="2026-09-24" carA={carA} carB={carB} />);
    expect(screen.getByText(he.carSwap.seriesQuestion)).toBeInTheDocument();
    fireEvent.click(screen.getByText(he.carSwap.seriesDayOnly));
    fireEvent.click(screen.getByText(he.common.confirm));
    await vi.waitFor(() => expect(mocks.mutateAsync).toHaveBeenCalledWith(expect.objectContaining({ seriesMode: "day" })));
  });

  it("does not render a series choice when no moved ride is part of one", () => {
    previewState = { isLoading: false, isError: false, data: preview() };
    render(<CarSwapDialog open onOpenChange={vi.fn()} departmentId="d" weekStart="2026-09-20" day="2026-09-24" carA={carA} carB={carB} />);
    expect(screen.queryByText(he.carSwap.seriesQuestion)).not.toBeInTheDocument();
  });
});
