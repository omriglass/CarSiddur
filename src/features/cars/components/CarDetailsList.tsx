// R20U10 (owner 2026-11-14): a viewer who may not edit the car sees its details as a plain list, not a greyed-out form.
// An empty code reads "לא הוגדר"; a code the viewer may not read (not a member of the car's department) is left out.
import type { ReactNode } from "react";

import type { Car } from "@/features/admin/cars/api";
import { FEATURE_LABEL } from "@/features/admin/cars/components/carFeatureLabels";
import { useDestinations } from "@/features/fleet/hooks";
import { he } from "@/i18n/he";

interface CarDetailsListProps {
  car: Car;
  /** Shown in place of the responsible person's id (the caller already looked the name up). */
  responsibleName: string | null;
  /** Whether the viewer may read the car's codes (a member of its department, or an admin). */
  codeVisible: boolean;
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function CarDetailsList({ car, responsibleName, codeVisible }: CarDetailsListProps) {
  const destinations = useDestinations(car.department_id);
  const base = car.base_location_id
    ? (destinations.data ?? []).find((d) => d.id === car.base_location_id)?.name ?? ""
    : he.adminCars.fieldBaseLocationHome;
  const features = (car.features ?? []).filter((f): f is keyof typeof FEATURE_LABEL => f in FEATURE_LABEL);

  return (
    <dl className="flex flex-col" data-testid="car-details-list">
      {codeVisible ? (
        <Row label={he.adminCars.fieldAccessCode} testId="car-details-code">
          {car.access_code ? <span dir="ltr">{car.access_code}</span> : <span className="text-muted-foreground">{he.carPage.codeUnset}</span>}
        </Row>
      ) : null}
      {codeVisible && car.is_replaced && car.replacement_code ? (
        <Row label={he.adminCars.fieldReplacementCode}><span dir="ltr">{car.replacement_code}</span></Row>
      ) : null}
      <Row label={he.adminCars.fieldResponsible}>{responsibleName || he.adminCars.fieldResponsibleNone}</Row>
      <Row label={he.adminCars.fieldBaseLocation} testId="car-details-base">{base}</Row>
      {features.length > 0 ? (
        <Row label={he.adminCars.fieldFeatures}>{features.map((f) => FEATURE_LABEL[f]).join(" · ")}</Row>
      ) : null}
      {car.built_in_child_seats > 0 ? (
        <Row label={he.adminCars.fieldBuiltInChildSeats}><span dir="ltr">{car.built_in_child_seats}</span></Row>
      ) : null}
      {car.built_in_boosters > 0 ? (
        <Row label={he.adminCars.fieldBuiltInBoosters}><span dir="ltr">{car.built_in_boosters}</span></Row>
      ) : null}
      {car.notes ? <Row label={he.adminCars.fieldNotes}><span className="whitespace-pre-wrap">{car.notes}</span></Row> : null}
    </dl>
  );
}
