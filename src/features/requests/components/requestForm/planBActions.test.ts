import { describe, expect, it, vi } from "vitest";
import type { UseFormReturn } from "react-hook-form";

import type { RequestFormValues } from "../../schema";
import { planBActions } from "./planBActions";

function fakeForm(submitCount: number) {
  const setValue = vi.fn();
  const form = {
    formState: { submitCount },
    setValue,
    getValues: () => ({ tripType: "round_trip", departTime: "08:00", returnTime: "18:00", departAnchor: "leave" }),
    clearErrors: vi.fn(),
  } as unknown as UseFormReturn<RequestFormValues>;
  return { form, setValue };
}

describe("planBActions validation timing", () => {
  it("does not validate before a submit attempt", () => {
    const { form, setValue } = fakeForm(0);
    planBActions(form).choose("alternative");
    expect(setValue).toHaveBeenCalled();
    for (const call of setValue.mock.calls) expect(call[2]).toMatchObject({ shouldValidate: false });
  });

  it("validates edits after a submit attempt", () => {
    const { form, setValue } = fakeForm(1);
    planBActions(form).set.altArriveBy("09:00");
    expect(setValue).toHaveBeenCalledWith("altArriveBy", "09:00", { shouldDirty: true, shouldValidate: true });
  });
});
