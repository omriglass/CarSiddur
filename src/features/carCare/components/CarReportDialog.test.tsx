import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he, tv } from "@/i18n/he";

import { CarReportDialog } from "./CarReportDialog";

const mocks = vi.hoisted(() => ({
  reportIssue: vi.fn(),
  logCarCare: vi.fn(),
  logKilometrage: vi.fn(),
  currentKm: { data: null as null | { km: number; recorded_at: string }, isLoading: false },
  car: { data: { fuel_type: null as null | string, tire_pressure_front_psi: null as null | number, tire_pressure_rear_psi: null as null | number } },
  openIssues: { data: [] as { id: string; car_id: string; description: string; is_unsafe: boolean; created_at: string }[] },
  guides: { data: [] as { id: string; car_id: string; department_id: string; topic_id: string | null; title: string; steps: { text: string }[]; updated_at: string }[], isLoading: false },
}));

vi.mock("@/features/cars/guides/hooks", () => ({
  useCarGuidesQuery: () => mocks.guides,
  useGuideTopicsQuery: () => ({ data: [] }),
}));

vi.mock("../hooks", () => ({
  useReportCarIssueMutation: () => ({ mutateAsync: mocks.reportIssue, isPending: false }),
  useLogCarCareMutation: () => ({ mutateAsync: mocks.logCarCare, isPending: false }),
  useLogCarKilometrageMutation: () => ({ mutateAsync: mocks.logKilometrage, isPending: false }),
}));

vi.mock("@/features/cars/hooks", () => ({
  useCarCurrentKmQuery: () => mocks.currentKm,
  useCarQuery: () => mocks.car,
  useOpenCarIssuesQuery: () => mocks.openIssues,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  mocks.reportIssue.mockReset().mockResolvedValue("issue-1");
  mocks.logCarCare.mockReset().mockResolvedValue("event-1");
  mocks.logKilometrage.mockReset().mockResolvedValue("reading-1");
  mocks.currentKm.data = null;
  mocks.car.data = { fuel_type: null, tire_pressure_front_psi: null, tire_pressure_rear_psi: null };
  mocks.openIssues.data = [];
  mocks.guides.data = [];
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

  it("urea (FU2): a car that is not diesel offers no urea", () => {
    show();
    expect(screen.queryByText(he.carCare.homeUreaFillTitle)).not.toBeInTheDocument();
  });

  it("urea on a diesel car: fill only, no \"needs urea\" report (owner 2026-11-13)", () => {
    mocks.car.data = { fuel_type: "diesel", tire_pressure_front_psi: null, tire_pressure_rear_psi: null };
    show();
    expect(screen.getByTestId("car-urea-fill")).toBeInTheDocument();
    expect(screen.queryByTestId("car-urea-need")).not.toBeInTheDocument();
  });

  it("urea fill: the game's skip logs a urea fill and shows the smiling boy", async () => {
    mocks.car.data = { fuel_type: "diesel", tire_pressure_front_psi: null, tire_pressure_rear_psi: null };
    show();
    fireEvent.click(screen.getByTestId("car-urea-fill"));
    expect(screen.getByTestId("urea-game")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.carCare.ureaSkip }));
    await waitFor(() => expect(mocks.logCarCare).toHaveBeenCalledWith({ carId: "car-1", kind: "urea_fill" }));
    expect(await screen.findByText(he.carCare.ureaCelebration)).toBeInTheDocument();
  });

  it("urea fill carries an optional note, like a tire fill (owner 2026-11-13)", async () => {
    mocks.car.data = { fuel_type: "diesel", tire_pressure_front_psi: null, tire_pressure_rear_psi: null };
    show();
    fireEvent.click(screen.getByTestId("car-urea-fill"));
    fireEvent.change(screen.getByTestId("urea-note"), { target: { value: "  מילאתי חצי  " } });
    fireEvent.click(screen.getByRole("button", { name: he.carCare.ureaSkip }));
    await waitFor(() => expect(mocks.logCarCare).toHaveBeenCalledWith({ carId: "car-1", kind: "urea_fill", note: "מילאתי חצי" }));
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

  it("CR1: the problem step lists the car's open issues first; the tires step shows the recommended pressure", () => {
    mocks.openIssues.data = [{ id: "i1", car_id: "car-1", description: "נורית שמן דולקת", is_unsafe: true, created_at: "2026-11-12T08:00:00Z" }];
    mocks.car.data = { fuel_type: null, tire_pressure_front_psi: 32, tire_pressure_rear_psi: 30 };
    show();
    fireEvent.click(screen.getByText(he.carCare.homeProblemTitle));
    expect(screen.getByText(he.carCare.problemOpenIssues)).toBeInTheDocument();
    expect(screen.getByText("נורית שמן דולקת")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.common.back }));
    fireEvent.click(screen.getByText(he.carCare.homeTireFillTitle));
    expect(screen.getByTestId("tire-recommended").textContent).toBe(tv("carCare.tireRecommended", { front: "32", rear: "30" }));
  });

  it("CG1 (REQ item 259): offers 'איך עושים…' only when the car has guides; a guide opens step by step", () => {
    const { unmount } = show();
    expect(screen.queryByTestId("car-menu-guides")).toBeNull();
    unmount();
    mocks.guides.data = [{ id: "g1", car_id: "car-1", department_id: "d1", topic_id: null, title: "כיסא בטיחות", steps: [{ text: "צעד א" }, { text: "צעד ב" }], updated_at: "" }];
    show();
    fireEvent.click(screen.getByTestId("car-menu-guides"));
    fireEvent.click(screen.getByText("כיסא בטיחות"));
    expect(screen.getByTestId("guide-step-of").textContent).toBe(tv("carGuides.stepOf", { n: "1", total: "2" }));
    expect(screen.getByTestId("guide-step").textContent).toBe("צעד א");
    fireEvent.click(screen.getByTestId("guide-step"));
    expect(screen.getByTestId("guide-step").textContent).toBe("צעד ב");
    fireEvent.click(screen.getByTestId("guide-prev"));
    expect(screen.getByTestId("guide-step").textContent).toBe("צעד א");
    fireEvent.keyDown(screen.getByTestId("guide-step"), { key: "ArrowLeft" });
    fireEvent.click(screen.getByTestId("guide-done"));
    expect(screen.getByTestId("car-guides-list")).toBeInTheDocument();
  });
});
