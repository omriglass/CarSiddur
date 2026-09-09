import { act, render } from "@testing-library/react";
import { useForm, useWatch } from "react-hook-form";
import { describe, expect, it } from "vitest";

/**
 * Regression for the render-phase sync in `RequestForm.tsx` that forces a quick one-way
 * request's `oneWayCarMode` to `"passenger"`. That field's own `Controller` only mounts when
 * `!quickContext`, so in the quick variant it is never a *registered* field — `useWatch`'s
 * all-fields snapshot only reflects registered fields, so it kept reading back `undefined`
 * forever even right after `form.setValue("oneWayCarMode", "passenger")` ran (confirmed live in
 * a real browser: `form.getValues("oneWayCarMode")` correctly shows `"passenger"` immediately,
 * while the same render's `useWatch` snapshot never does). The old guard
 * (`values.oneWayCarMode !== "passenger"`) therefore never converged: any external re-render
 * (query refetches, unrelated state) re-observed the permanently stale `undefined` and called
 * `setValue` again — a genuine infinite render loop in production (thousands of calls/second,
 * tab unresponsive). The fix reads the authoritative `form.getValues(...)` instead, which
 * reflects the write on the very next check. This test exercises the same "unregistered field,
 * all-fields `useWatch`, render-phase `setValue`" shape in isolation to characterize and guard
 * the underlying react-hook-form behavior directly (the full `RequestForm` has enough other
 * query-driven renders that a bare "does it throw" assertion there is unreliable in jsdom).
 */
function Harness({ readStale }: { readStale: boolean }) {
  const form = useForm<{ tripShape: string; oneWayCarMode?: string }>({
    defaultValues: { tripShape: "one_way_to", oneWayCarMode: undefined },
    resolver: async (fieldValues) => ({ values: fieldValues, errors: {} }),
    mode: "onBlur",
  });
  // No `register`/`Controller` ever mounts for `oneWayCarMode` — mirrors the quick variant,
  // where its own control only renders when `!quickContext`.
  const values = useWatch({ control: form.control });
  const current = readStale ? values.oneWayCarMode : form.getValues("oneWayCarMode");
  if (current !== "passenger") {
    form.setValue("oneWayCarMode", "passenger", { shouldValidate: true });
  }
  return (
    <div>
      <div data-testid="value">{String(form.getValues("oneWayCarMode"))}</div>
      <div data-testid="watched">{String(values.oneWayCarMode)}</div>
    </div>
  );
}

describe("RequestForm's quick one-way oneWayCarMode render-phase sync", () => {
  it("never reflects the write in the unregistered field's useWatch snapshot (the bug)", async () => {
    const { getByTestId } = render(<Harness readStale />);
    // `form.getValues` proves the write landed; flush any pending validation/notify microtasks
    // and re-check — `watched` must still show the write never arriving via `useWatch`.
    expect(getByTestId("value").textContent).toBe("passenger");
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByTestId("watched").textContent).toBe("undefined");
  });

  it("converges immediately when the guard reads form.getValues instead (the fix)", () => {
    const { getByTestId } = render(<Harness readStale={false} />);
    expect(getByTestId("value").textContent).toBe("passenger");
  });
});
