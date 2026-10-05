import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { describe, expect, it } from "vitest";

import { he } from "@/i18n/he";
import type { TripType } from "@/lib/enums";

import { TripTypeFields } from "./TripTypeFields";
import type { RequestFormValues } from "../../schema";

type Form = ReturnType<typeof useForm<RequestFormValues>>;
const captured: { form?: Form } = {};

function Harness() {
  const form = useForm<RequestFormValues>({
    defaultValues: { tripType: "round_trip", dropOffPickup: false, tripShape: "round_trip", needsCarAtDestination: true, departTime: "08:00", returnTime: "17:30" } as RequestFormValues,
  });
  useEffect(() => { captured.form = form; });
  const tripType = (useWatch({ control: form.control, name: "tripType" }) ?? "round_trip") as TripType;
  return <TripTypeFields control={form.control} form={form} variant="weekly" tripType={tripType} dropOffPickup={false} canDrive />;
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
});
