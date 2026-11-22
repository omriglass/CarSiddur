import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render as baseRender, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";
import type { TripType } from "@/lib/enums";

import { TripTypeFields } from "./TripTypeFields";
import type { RequestFormValues } from "../../schema";

const render = (ui: ReactElement) => baseRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

type Form = ReturnType<typeof useForm<RequestFormValues>>;
const captured: { form?: Form } = {};

function Harness({ pill = false, start = "round_trip" }: { pill?: boolean; start?: TripType }) {
  const form = useForm<RequestFormValues>({
    defaultValues: { tripType: start, dropOffPickup: false, tripShape: start === "drop_off" ? "one_way_to" : "round_trip", needsCarAtDestination: true, departTime: "08:00", returnTime: "17:30", returnStops: [{ presetId: "x1", name: "X" }], outStops: [] } as unknown as RequestFormValues,
  });
  useEffect(() => { captured.form = form; });
  const tripType = (useWatch({ control: form.control, name: "tripType" }) ?? "round_trip") as TripType;
  const dropOffPickup = (useWatch({ control: form.control, name: "dropOffPickup" }) ?? false) as boolean;
  return <TripTypeFields control={form.control} form={form} variant="weekly" tripType={tripType} dropOffPickup={dropOffPickup} canDrive pill={pill} />;
}

describe("TripTypeFields keeps the return time", () => {
  it("round trip -> one way -> round trip keeps the same returnTime", () => {
    render(<Harness />);
    const form = () => captured.form as Form;
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeOneWay }));
    expect(form().getValues("tripShape")).toBe("one_way_to");
    expect(form().getValues("returnTime")).toBe("17:30");
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeRoundTrip }));
    expect(form().getValues("tripShape")).toBe("round_trip");
    expect(form().getValues("returnTime")).toBe("17:30");
  });

  it("keeps return stops in form state (and the payload) through one way and back (REQ §13.97)", () => {
    render(<Harness />);
    const form = () => captured.form as Form;
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeOneWay }));
    expect(form().getValues("returnStops")).toEqual([{ presetId: "x1", name: "X" }]);
    fireEvent.click(screen.getByRole("radio", { name: he.request.tripTypeRoundTrip }));
    expect(form().getValues("returnStops")).toEqual([{ presetId: "x1", name: "X" }]);
  });

  it("the sentence layout's \"הקפצה ואיסוף\" asks the pickup hour there, not home-by (R22B13)", () => {
    render(<Harness pill start="drop_off" />);
    const form = () => captured.form as Form;
    fireEvent.click(screen.getByTestId("drop-off-mode-both"));
    expect(form().getValues("returnAnchor")).toBe("leave");
    expect(form().getValues("leaveDestTime")).toBe("17:30");
  });

  it("the classic layout keeps the home-by hour", () => {
    render(<Harness start="drop_off" />);
    const form = () => captured.form as Form;
    fireEvent.click(screen.getByTestId("drop-off-mode-both"));
    expect(form().getValues("returnAnchor")).toBeUndefined();
  });
});
