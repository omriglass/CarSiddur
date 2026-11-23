import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { Car, CarUpdate } from "@/features/admin/cars/api";
import type { ResponsibleOption } from "@/features/admin/cars/components/CarForm";
import { FEATURE_LABEL } from "@/features/admin/cars/components/carFeatureLabels";
import { CAR_FEATURES } from "@/features/admin/cars/schema";
import { useDestinations } from "@/features/fleet/hooks";
import { formatPlate } from "@/lib/plate";
import { he } from "@/i18n/he";

import { useSaveCarFieldsMutation } from "../hooks";
import { tirePressureError, tirePressureLabel, type TirePressureDraft } from "../lib/carDetails";
import { DetailRow, EditableRow } from "./EditableRow";

/** Radix Select treats "" as "no value", so "home" / "nobody" need a real value (R20U9). */
const NONE = "__none";
const CODE_RE = /^([0-9]{4,5})?$/;

interface Props {
  car: Car;
  /** Admin, the department's Sadran or the car's responsible person (the cars write policies re-check). */
  canEdit: boolean;
  /** Admin or the department's Sadran: may pick the responsible person. */
  canEditResponsible: boolean;
  responsibleOptions: ResponsibleOption[];
  /** A member of the car's department, or an admin (R20U10). */
  codeVisible: boolean;
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;

/**
 * CR1 (REQ item 257): "לכל מי שנוסע/ת ברכב" — what anyone taking the car needs: the code, where it stands, the
 * recommended tire pressure, its features, who is responsible, the notes. Edited in place (`EditableRow`).
 */
export function CarFactsCard({ car, canEdit, canEditResponsible, responsibleOptions, codeVisible }: Props) {
  const save = useSaveCarFieldsMutation();
  const destinations = useDestinations(car.department_id);
  const patch = (fields: CarUpdate) => save.mutateAsync({ carId: car.id, patch: fields }).then(() => undefined);
  const baseName = car.base_location_id
    ? (destinations.data ?? []).find((d) => d.id === car.base_location_id)?.name ?? ""
    : he.adminCars.fieldBaseLocationHome;
  const features = (car.features ?? []).filter((f): f is keyof typeof FEATURE_LABEL => f in FEATURE_LABEL);
  const responsibleName = responsibleOptions.find((o) => o.id === car.responsible_id)?.name ?? null;
  const tire = tirePressureLabel(car.tire_pressure_front_psi, car.tire_pressure_rear_psi);

  return (
    <Card className="bg-gradient-card shadow-card">
      <CardContent className="p-3">
        <dl className="flex flex-col" data-testid="car-details-list">
          {codeVisible ? (
            <EditableRow<string>
              label={he.adminCars.fieldAccessCode}
              testId="car-details-code"
              value={car.access_code ? <span dir="ltr" className="text-lg font-bold tracking-widest">{car.access_code}</span> : muted(he.carPage.codeUnset)}
              editable={canEdit}
              initial={car.access_code ?? ""}
              validate={(code) => (!CODE_RE.test(code.trim()) ? he.adminCars.codeDigitsRequired : null)}
              editor={({ draft, setDraft, inputId }) => (
                <Input id={inputId} dir="ltr" inputMode="numeric" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="car-details-code-input" />
              )}
              onSave={(code) => patch({ access_code: code.trim() || null, is_replaced: car.is_replaced, replacement_code: car.replacement_code, replacement_plate: car.replacement_plate })}
            />
          ) : null}
          {codeVisible && (car.is_replaced || canEdit) ? (
            <EditableRow<{ replaced: boolean; code: string; plate: string }>
              label={he.adminCars.fieldIsReplaced}
              testId="car-details-replacement"
              value={car.is_replaced ? (
                <span className="flex flex-wrap items-center gap-2">
                  {car.replacement_code ? <span dir="ltr" className="font-semibold">{car.replacement_code}</span> : he.adminCars.replacedBadge}
                  {car.replacement_plate ? <span dir="ltr" data-testid="car-details-replacement-plate">{formatPlate(car.replacement_plate)}</span> : null}
                </span>
              ) : muted("—")}
              editable={canEdit}
              initial={{ replaced: car.is_replaced, code: car.replacement_code ?? "", plate: car.replacement_plate ?? "" }}
              validate={({ replaced, code }) =>
                replaced && !CODE_RE.test(code.trim()) ? he.adminCars.codeDigitsRequired : null}
              editor={({ draft, setDraft, inputId }) => (
                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox checked={draft.replaced} onCheckedChange={(checked) => setDraft({ ...draft, replaced: checked === true })} />
                    {he.adminCars.fieldIsReplaced}
                  </label>
                  {draft.replaced ? (
                    <>
                      <Input id={inputId} dir="ltr" inputMode="numeric" autoFocus placeholder={he.adminCars.fieldReplacementCode} aria-label={he.adminCars.fieldReplacementCode} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                      <Input dir="ltr" placeholder={he.adminCars.fieldReplacementPlate} aria-label={he.adminCars.fieldReplacementPlate} value={draft.plate} onChange={(e) => setDraft({ ...draft, plate: e.target.value })} data-testid="car-details-replacement-plate-input" />
                    </>
                  ) : null}
                </div>
              )}
              onSave={({ replaced, code, plate }) => patch({ access_code: car.access_code, is_replaced: replaced, replacement_code: replaced ? code.trim() || null : null, replacement_plate: replaced ? plate.trim() || null : null })}
            />
          ) : null}
          <EditableRow<string>
            label={he.adminCars.fieldBaseLocation}
            testId="car-details-base"
            value={baseName}
            editable={canEdit}
            initial={car.base_location_id ?? NONE}
            editor={({ draft, setDraft, inputId }) => (
              <Select value={draft} onValueChange={setDraft}>
                <SelectTrigger id={inputId}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{he.adminCars.fieldBaseLocationHome}</SelectItem>
                  {(destinations.data ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            onSave={(id) => patch({ base_location_id: id === NONE ? null : id })}
          />
          <EditableRow<TirePressureDraft>
            label={he.adminCars.fieldTirePressure}
            testId="car-details-tires"
            value={tire ?? muted("—")}
            editable={canEdit}
            initial={{ front: car.tire_pressure_front_psi?.toString() ?? "", rear: car.tire_pressure_rear_psi?.toString() ?? "" }}
            validate={tirePressureError}
            editor={({ draft, setDraft, inputId }) => (
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {he.adminCars.tireFront}
                  <Input id={inputId} dir="ltr" inputMode="numeric" autoFocus value={draft.front} onChange={(e) => setDraft({ ...draft, front: e.target.value })} data-testid="car-tire-front" />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {he.adminCars.tireRear}
                  <Input dir="ltr" inputMode="numeric" value={draft.rear} onChange={(e) => setDraft({ ...draft, rear: e.target.value })} data-testid="car-tire-rear" />
                </label>
              </div>
            )}
            onSave={({ front, rear }) => patch({
              tire_pressure_front_psi: front.trim() ? Number(front) : null,
              tire_pressure_rear_psi: rear.trim() ? Number(rear) : null,
            })}
          />
          <EditableRow<string[]>
            label={he.adminCars.fieldFeatures}
            testId="car-details-features"
            value={features.length ? features.map((f) => FEATURE_LABEL[f]).join(" · ") : muted("—")}
            editable={canEdit}
            initial={car.features ?? []}
            editor={({ draft, setDraft }) => (
              <div className="flex flex-wrap gap-x-4 gap-y-2 py-1">
                {CAR_FEATURES.map((feature) => (
                  <label key={feature} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={draft.includes(feature)}
                      onCheckedChange={(checked) => setDraft(checked ? [...draft, feature] : draft.filter((f) => f !== feature))}
                    />
                    {FEATURE_LABEL[feature]}
                  </label>
                ))}
              </div>
            )}
            onSave={(next) => patch({ features: next })}
          />
          {canEditResponsible ? (
            <EditableRow<string>
              label={he.adminCars.fieldResponsible}
              testId="car-details-responsible"
              value={responsibleName || muted(he.adminCars.fieldResponsibleNone)}
              editable
              initial={car.responsible_id ?? NONE}
              editor={({ draft, setDraft, inputId }) => (
                <Select value={draft} onValueChange={setDraft}>
                  <SelectTrigger id={inputId}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>{he.adminCars.fieldResponsibleNone}</SelectItem>
                    {responsibleOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              onSave={(id) => patch({ responsible_id: id === NONE ? null : id })}
            />
          ) : (
            <DetailRow label={he.adminCars.fieldResponsible} testId="car-details-responsible">
              {responsibleName || muted(he.adminCars.fieldResponsibleNone)}
            </DetailRow>
          )}
          {car.notes || canEdit ? (
            <EditableRow<string>
              label={he.adminCars.fieldNotes}
              testId="car-details-notes"
              value={car.notes ? <span className="whitespace-pre-wrap">{car.notes}</span> : muted("—")}
              editable={canEdit}
              initial={car.notes ?? ""}
              editor={({ draft, setDraft, inputId }) => (
                <Textarea id={inputId} autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
              )}
              onSave={(notes) => patch({ notes: notes.trim() || null })}
            />
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}
