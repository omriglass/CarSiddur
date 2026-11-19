import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Car, CarUpdate } from "@/features/admin/cars/api";
import { SeatConfigEditor } from "@/features/admin/cars/components/SeatConfigEditor";
import { useReplaceSeatConfigsMutation, useSeatConfigs } from "@/features/admin/cars/hooks";
import { he } from "@/i18n/he";
import { CAR_FUEL_TYPES, CAR_STATUSES } from "@/lib/enums";
import { formatPlate } from "@/lib/plate";
import { showErrorToast } from "@/lib/rpc";

import type { Passengers } from "@/solver";

import { useCarCorporationsQuery, useSaveCarFieldsMutation } from "../hooks";
import { seatConfigSummary } from "../lib/carDetails";
import { CarPrivateSwitch } from "./CarPrivateSwitch";
import { DetailRow, EditableRow } from "./EditableRow";

const UNSET = "__unset";

interface Props {
  car: Car;
  canEdit: boolean;
  /** Admin, or an editor of a private car (RLS: `car_seat_configs` writes). */
  canEditSeatConfigs: boolean;
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
const countText = (n: number) => <span dir="ltr">{n}</span>;

/**
 * CR1 (REQ item 257): "פרטי רישום" in the car page's "לניהול הרכב" part — name, plate, fuel, corporation, status,
 * built-in seats, seat configurations (a dialog: the table does not fit in a row) and the private-car checkbox.
 */
export function CarRegistrationCard({ car, canEdit, canEditSeatConfigs }: Props) {
  const save = useSaveCarFieldsMutation();
  const patch = (fields: CarUpdate) => save.mutateAsync({ carId: car.id, patch: fields }).then(() => undefined);
  const corporations = useCarCorporationsQuery(canEdit);
  const seatConfigsQuery = useSeatConfigs(car.id);
  const replaceSeatConfigs = useReplaceSeatConfigsMutation();
  const [seatsOpen, setSeatsOpen] = useState(false);
  const [pendingSeats, setPendingSeats] = useState<Passengers[] | null>(null);
  const configs = (seatConfigsQuery.data ?? []).map((sc) => ({ adults: sc.adults, childSeats: sc.child_seats, boosters: sc.boosters }));
  const seatsLine = seatConfigSummary(configs);
  const nonNegative = (text: string) => (/^\d{1,2}$/.test(text.trim()) ? null : he.carCare.kmInvalid);

  async function saveSeats() {
    if (!pendingSeats) { setSeatsOpen(false); return; }
    try {
      await replaceSeatConfigs.mutateAsync({ carId: car.id, configs: pendingSeats });
      toast.success(he.adminCommon.savedToast);
      setSeatsOpen(false);
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <Card className="bg-gradient-card shadow-card" data-testid="car-registration-card">
      <CardContent className="space-y-2 p-3">
        <h3 className="text-sm font-semibold">{he.carPage.registrationTitle}</h3>
        <dl className="flex flex-col">
          <EditableRow<string>
            label={he.adminCars.fieldName}
            testId="car-reg-name"
            value={car.name}
            editable={canEdit}
            initial={car.name}
            validate={(name) => (name.trim() ? null : he.adminCommon.required)}
            editor={({ draft, setDraft, inputId }) => <Input id={inputId} autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />}
            onSave={(name) => patch({ name: name.trim() })}
          />
          <EditableRow<string>
            label={he.adminCars.fieldPlate}
            testId="car-reg-plate"
            value={<span dir="ltr">{formatPlate(car.license_plate)}</span>}
            editable={canEdit}
            initial={car.license_plate}
            validate={(plate) => (plate.trim() ? null : he.adminCommon.required)}
            editor={({ draft, setDraft, inputId }) => <Input id={inputId} dir="ltr" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />}
            onSave={(plate) => patch({ license_plate: plate.trim() })}
          />
          <EditableRow<string>
            label={he.car.fuelLabel}
            testId="car-reg-fuel"
            value={car.fuel_type ? he.car.fuel[car.fuel_type] : muted(he.car.fuelUnset)}
            editable={canEdit}
            initial={car.fuel_type ?? UNSET}
            editor={({ draft, setDraft, inputId }) => (
              <Select value={draft} onValueChange={setDraft}>
                <SelectTrigger id={inputId} data-testid="car-fuel-type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>{he.car.fuelUnset}</SelectItem>
                  {CAR_FUEL_TYPES.map((fuel) => <SelectItem key={fuel} value={fuel}>{he.car.fuel[fuel]}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            onSave={(fuel) => patch({ fuel_type: fuel === UNSET ? null : (fuel as Car["fuel_type"]) })}
          />
          <EditableRow<string>
            label={he.adminCars.fieldCorporation}
            testId="car-reg-corporation"
            value={car.corporation || muted("—")}
            editable={canEdit}
            initial={car.corporation ?? ""}
            validate={(text) => (text.trim().length > 80 ? he.adminCommon.errorGeneric : null)}
            editor={({ draft, setDraft, inputId }) => {
              const listId = `${inputId}-list`;
              return (
                <>
                  <Input id={inputId} autoFocus list={listId} value={draft} onChange={(e) => setDraft(e.target.value)} data-testid="car-corporation-input" />
                  <datalist id={listId}>{(corporations.data ?? []).map((name) => <option key={name} value={name} />)}</datalist>
                </>
              );
            }}
            onSave={(text) => patch({ corporation: text.trim() || null })}
          />
          {canEdit ? (
            <EditableRow<Car["status"]>
              label={he.adminCars.fieldStatus}
              testId="car-reg-status"
              value={he.car.status[car.status]}
              editable
              initial={car.status}
              editor={({ draft, setDraft, inputId }) => (
                <Select value={draft} onValueChange={(value) => setDraft(value as Car["status"])}>
                  <SelectTrigger id={inputId}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CAR_STATUSES.map((status) => <SelectItem key={status} value={status}>{he.car.status[status]}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              onSave={(status) => patch({ status })}
            />
          ) : (
            <DetailRow label={he.adminCars.fieldStatus}>{he.car.status[car.status]}</DetailRow>
          )}
          <EditableRow<string>
            label={he.adminCars.fieldBuiltInChildSeats}
            testId="car-reg-child-seats"
            value={countText(car.built_in_child_seats)}
            editable={canEdit}
            initial={String(car.built_in_child_seats)}
            validate={nonNegative}
            editor={({ draft, setDraft, inputId }) => <Input id={inputId} dir="ltr" inputMode="numeric" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />}
            onSave={(n) => patch({ built_in_child_seats: Number(n) })}
          />
          <EditableRow<string>
            label={he.adminCars.fieldBuiltInBoosters}
            testId="car-reg-boosters"
            value={countText(car.built_in_boosters)}
            editable={canEdit}
            initial={String(car.built_in_boosters)}
            validate={nonNegative}
            editor={({ draft, setDraft, inputId }) => <Input id={inputId} dir="ltr" inputMode="numeric" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} />}
            onSave={(n) => patch({ built_in_boosters: Number(n) })}
          />
          <DetailRow label={he.cars.seatConfigs} testId="car-reg-seats">
            <span className="flex items-start justify-between gap-2">
              <span className="min-w-0 flex-1">{seatsLine ?? muted(he.carPage.seatConfigsNone)}</span>
              {canEditSeatConfigs && seatConfigsQuery.isSuccess ? (
                <button
                  type="button"
                  className="shrink-0 text-xs font-semibold text-primary hover:underline"
                  onClick={() => { setPendingSeats(null); setSeatsOpen(true); }}
                  data-testid="car-reg-seats-edit"
                >
                  {he.carPage.editField}
                </button>
              ) : null}
            </span>
          </DetailRow>
        </dl>
        <CarPrivateSwitch car={car} canEdit={canEdit} />
      </CardContent>
      <FormDialog
        open={seatsOpen}
        onOpenChange={setSeatsOpen}
        title={he.cars.seatConfigs}
        submitLabel={he.carPage.saveField}
        loading={replaceSeatConfigs.isPending}
        onSubmit={() => void saveSeats()}
      >
        {seatsOpen ? <SeatConfigEditor initial={configs} onChange={setPendingSeats} /> : null}
      </FormDialog>
    </Card>
  );
}
