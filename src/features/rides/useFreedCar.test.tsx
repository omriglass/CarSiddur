// REQ item 237: every freed-car prompt has a third answer, "… בלי להעביר את הרכב — אסתדר מחוץ לאפליקציה".
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { he } from "@/i18n/he";

import { FreedCarConfirmDialog } from "./FreedCarConfirmDialog";
import { useFreedCarGate } from "./useFreedCar";

const line = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("./freedCarPreview", () => ({ fetchFreedCarLine: vi.fn(async () => line.text) }));

const request = { action: "cancel_ride", args: {} } as never;

function Harness({ save }: { save: (keepOut: boolean) => void }) {
  const gate = useFreedCarGate();
  return (
    <>
      <button type="button" onClick={() => void gate.run(request, save)}>go</button>
      <FreedCarConfirmDialog dialog={gate.dialog} />
    </>
  );
}

async function start(save: (keepOut: boolean) => void) {
  render(<Harness save={save} />);
  await act(async () => { fireEvent.click(screen.getByText("go")); });
}

describe("useFreedCarGate + FreedCarConfirmDialog", () => {
  beforeEach(() => { line.text = "בעקבות השינוי דנה יקבל/תקבל את הרכב בשעות האלה. תודה!"; });

  it("nobody waiting gets the car: saves at once, the ordinary way", async () => {
    line.text = null;
    const save = vi.fn();
    await start(save);
    expect(save).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("freed-car-keep-out")).toBeNull();
  });

  it("\"לשמור\" saves the ordinary way", async () => {
    const save = vi.fn();
    await start(save);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: he.freedCar.confirmSave })); });
    expect(save).toHaveBeenCalledWith(false);
  });

  it("the third button saves without offering the car", async () => {
    const save = vi.fn();
    await start(save);
    const keep = screen.getByTestId("freed-car-keep-out");
    expect(keep.textContent).toBe("לשמור בלי להעביר את הרכב — אסתדר מחוץ לאפליקציה");
    await act(async () => { fireEvent.click(keep); });
    expect(save).toHaveBeenCalledWith(true);
  });

  it("\"חזרה\" saves nothing", async () => {
    const save = vi.fn();
    await start(save);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: he.freedCar.confirmBack })); });
    expect(save).not.toHaveBeenCalled();
  });
});
