// Extracted from `BoardScreen.tsx` (docs/TODO.md "Code review 2026-09-24" R9):
// the "שמירת זמן" reservation dialog (owner A5, 2026-09-14) — a manual board
// slot-click reservation, optionally naming a driver/passengers/children.
// Pure move — behaviour and markup unchanged.
import { CompanionPicker } from "@/components/CompanionPicker";
import { PortalDialogContent } from "@/components/PortalDialogContent";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";

export interface ReservationState {
  carId: string;
  start: string;
  end: string;
  notes: string;
  memberIds: string[];
  childIds: string[];
  /** REQ §13.103 b: `move` = "העברת רכב" (mark_car_move) instead of a plain reservation. */
  kind: "reservation" | "move";
  toPlaceId: string;
}

export interface ReservationDialogProps {
  reservation: ReservationState | null;
  onChange: (next: ReservationState) => void;
  onOpenChange: (open: boolean) => void;
  selectedDay: string;
  cars: { id: string; name: string }[];
  members: { id: string; name: string }[];
  children: { id: string; name: string; age: number | null }[];
  /** Places for a car move's target. */
  places: { id: string; name: string }[];
  /** Where the car is at the dialog's start time (name), `null` when unknown. */
  carLocationName: string | null;
  onSave: () => void;
  saving: boolean;
}

export function ReservationDialog({ reservation, onChange, onOpenChange, selectedDay, cars, members, children, places, carLocationName, onSave, saving }: ReservationDialogProps) {
  return (
    <Dialog open={!!reservation} onOpenChange={(open) => !open && onOpenChange(false)}>
      <PortalDialogContent><DialogHeader><DialogTitle>{he.sadranBoard.reservation}</DialogTitle><DialogDescription>{selectedDay}</DialogDescription></DialogHeader>
        {reservation ? <>
          <div className="flex gap-2" role="radiogroup" aria-label={he.sadranBoard.reservation}>
            <Button type="button" role="radio" aria-checked={reservation.kind === "reservation"} variant={reservation.kind === "reservation" ? "default" : "outline"} className="min-h-11 flex-1" data-testid="reservation-kind-reservation" onClick={() => onChange({ ...reservation, kind: "reservation" })}>{he.sadranBoard.reservation}</Button>
            <Button type="button" role="radio" aria-checked={reservation.kind === "move"} variant={reservation.kind === "move" ? "default" : "outline"} className="min-h-11 flex-1" data-testid="reservation-kind-move" onClick={() => onChange({ ...reservation, kind: "move" })}>{he.sadranBoard.carMove}</Button>
          </div>
          <Select value={reservation.carId} onValueChange={(carId) => onChange({ ...reservation, carId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}</SelectContent></Select>
          <div className="flex gap-2"><TimeField15 min="00:00" aria-label={he.sadranRideSheet.depart} value={reservation.start} onChange={(start) => onChange({ ...reservation, start })} /><TimeField15 min="00:00" max="23:59" aria-label={he.sadranRideSheet.return} value={reservation.end} onChange={(end) => onChange({ ...reservation, end })} /></div>
          {reservation.kind === "move" ? (
            <div className="space-y-2" data-testid="car-move-fields">
              <p className="text-xs text-muted-foreground">{he.sadranBoard.carMoveHint}</p>
              <p className="text-sm" data-testid="car-move-from">{he.sadranBoard.carMoveFrom}{carLocationName ?? he.sadranBoard.carMoveFromUnknown}</p>
              <Select value={reservation.toPlaceId} onValueChange={(toPlaceId) => onChange({ ...reservation, toPlaceId })}>
                <SelectTrigger aria-label={he.sadranBoard.carMoveTo} data-testid="car-move-to"><SelectValue placeholder={he.sadranBoard.carMoveToPlaceholder} /></SelectTrigger>
                <SelectContent>{places.map((place) => <SelectItem key={place.id} value={place.id}>{place.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          ) : (
          <Textarea aria-label={he.sadranBoard.reservationNotes} placeholder={he.sadranBoard.reservationNotes} value={reservation.notes} onChange={(event) => onChange({ ...reservation, notes: event.target.value })} />
          )}
          <div className="space-y-1">
            <p className="text-sm font-medium">{he.sadranBoard.reservationPeople}</p>
            <p className="text-xs text-muted-foreground">{he.sadranBoard.reservationPeopleHint}</p>
            <CompanionPicker
              members={members.map((m) => ({ id: m.id, name: m.name }))}
              value={reservation.memberIds}
              onChange={(memberIds) => onChange({ ...reservation, memberIds })}
            />
          </div>
          {reservation.kind === "move" ? null : <div className="space-y-1">
            <CompanionPicker
              members={children.map((child) => ({
                id: child.id,
                name: child.age == null ? child.name : `${child.name} · ${child.age}`,
              }))}
              value={reservation.childIds}
              onChange={(childIds) => onChange({ ...reservation, childIds })}
              label={he.sadranBoard.reservationChildren}
            />
          </div>}
          <Button disabled={saving || !reservation.carId || (reservation.kind === "move" ? !reservation.toPlaceId : !reservation.notes.trim())} onClick={onSave}>{he.common.save}</Button>
        </> : null}
      </PortalDialogContent>
    </Dialog>
  );
}
