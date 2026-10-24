import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { CarReportDialog } from "./CarReportDialog";

const mocks = vi.hoisted(() => ({
  reportIssue: vi.fn(),
  logCarCare: vi.fn(),
  logKilometrage: vi.fn(),
  currentKm: { data: null as null | { km: number; recorded_at: string }, isLoading: false },
}));

vi.mock("../hooks", () => ({
  useReportCarIssueMutation: () => ({ mutateAsync: mocks.reportIssue, isPending: false }),
  useLogCarCareMutation: () => ({ mutateAsync: mocks.logCarCare, isPending: false }),
  useLogCarKilometrageMutation: () => ({ mutateAsync: mocks.logKilometrage, isPending: false }),
}));

vi.mock("@/features/cars/hooks", () => ({
  useCarCurrentKmQuery: () => mocks.currentKm,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  mocks.reportIssue.mockReset().mockResolvedValue("issue-1");
  mocks.logCarCare.mockReset().mockResolvedValue("event-1");
  mocks.logKilometrage.mockReset().mockResolvedValue("reading-1");
  mocks.currentKm.data = null;
});

function show(onOpenChange = vi.fn()) {
  return { onOpenChange, ...render(<CarReportDialog carId="car-1" carName="האוקטביה" open onOpenChange={onOpenChange} />) };
}

describe("CarReportDialog", () => {
  it("shows the three home actions under the car's name in the title", () => {
    show();
    expect(screen.getByText("דיווח על רכב האוקטביה")).toBeInTheDocument();
    expect(screen.getByText(he.carCare.homeProblemTitle)).toBeInTheDocument();
    expect(screen.getByText(he.carCare.homeTireFillTitle)).toBeInTheDocument();
    expect(screen.getByText(he.carCare.homeWashTitle)).toBeInTheDocument();
    expect(screen.getByText(he.carCare.homeKilometrageTitle)).toBeInTheDocument();
  });

  it("kilometrage: shows the last reading, keeps save disabled for non-numbers and logs a whole number", async () => {
    mocks.currentKm.data = { km: 12345, recorded_at: "2026-10-20T10:00:00Z" };
    const { onOpenChange } = show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeKilometrageTitle }));
    expect(screen.getByTestId("car-km-last")).toHaveTextContent("12,345");
    const save = screen.getByRole("button", { name: he.carCare.kmSave });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("car-km-input"), { target: { value: "12.5" } });
    expect(save).toBeDisabled();
    expect(screen.getByText(he.carCare.kmInvalid)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("car-km-input"), { target: { value: "12,400" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(mocks.logKilometrage).toHaveBeenCalledWith({ carId: "car-1", km: 12400 }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("the X closes the dialog without submitting anything", () => {
    const { onOpenChange } = show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeWashTitle }));
    expect(screen.getByRole("button", { name: he.carCare.washSkip })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "סגור" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.logCarCare).not.toHaveBeenCalled();
    expect(mocks.reportIssue).not.toHaveBeenCalled();
  });

  it("wash calls log_car_care('wash') exactly once and shows the celebration", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeWashTitle }));
    fireEvent.click(screen.getByRole("button", { name: he.carCare.washSkip }));

    await waitFor(() => expect(mocks.logCarCare).toHaveBeenCalledOnce());
    expect(mocks.logCarCare).toHaveBeenCalledWith({ carId: "car-1", kind: "wash" });
    expect(screen.getByText(he.carCare.washCelebration)).toBeInTheDocument();
  });

  it("submits a tire fill with the full five-position payload and an optional note", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeTireFillTitle }));
    const done = screen.getByRole("button", { name: he.carCare.tireDone });
    expect(done).toBeDisabled();
    const frontLeft = () => screen.getByTestId("tire-front_left");
    fireEvent.click(frontLeft()); // unchecked -> ok
    fireEvent.click(frontLeft()); // ok -> low
    expect(done).toBeEnabled();
    fireEvent.change(screen.getByLabelText(he.carCare.tireNoteLabel), { target: { value: "front left was soft" } });
    fireEvent.click(screen.getByRole("button", { name: he.carCare.tireDone }));

    await waitFor(() => expect(mocks.logCarCare).toHaveBeenCalledOnce());
    expect(mocks.logCarCare).toHaveBeenCalledWith({
      carId: "car-1",
      kind: "tire_fill",
      tires: {
        front_left: "low",
        front_right: "unchecked",
        rear_left: "unchecked",
        rear_right: "unchecked",
        spare: "unchecked",
      },
      note: "front left was soft",
    });
    expect(screen.getByText(he.carCare.tireCelebration)).toBeInTheDocument();
  });

  it("submits a problem report with the chosen category and description, then toasts and closes", async () => {
    const { onOpenChange } = show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeProblemTitle }));
    fireEvent.click(screen.getByRole("radio", { name: he.carCare.category.mechanical }));
    fireEvent.change(screen.getByPlaceholderText(he.carCare.descriptionPlaceholder), {
      target: { value: "Strange noise from the front" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.carCare.submitProblem }));

    await waitFor(() => expect(mocks.reportIssue).toHaveBeenCalledOnce());
    expect(mocks.reportIssue).toHaveBeenCalledWith({
      carId: "car-1",
      category: "mechanical",
      description: "Strange noise from the front",
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("blocks the problem submit until a category is chosen", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.homeProblemTitle }));
    fireEvent.change(screen.getByPlaceholderText(he.carCare.descriptionPlaceholder), {
      target: { value: "Something's wrong" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.carCare.submitProblem }));

    expect(await screen.findByText(he.carCare.categoryRequired)).toBeInTheDocument();
    expect(mocks.reportIssue).not.toHaveBeenCalled();
  });
});
