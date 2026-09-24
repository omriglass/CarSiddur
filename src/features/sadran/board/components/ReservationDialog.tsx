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
}

export interface ReservationDialogProps {
  reservation: ReservationState | null;
  onChange: (next: ReservationState) => void;
  onOpenChange: (open: boolean) => void;
  selectedDay: string;
  cars: { id: string; name: string }[];
  members: { id: string; name: string }[];
  children: { id: string; name: string; age: number | null }[];
  onSave: () => void;
  saving: boolean;
}

export function ReservationDialog({ reservation, onChange, onOpenChange, selectedDay, cars, members, children, onSave, saving }: ReservationDialogProps) {
  return (
    <Dialog open={!!reservation} onOpenChange={(open) => !open && onOpenChange(false)}>
      <PortalDialogContent><DialogHeader><DialogTitle>{he.sadranBoard.reservation}</DialogTitle><DialogDescription>{selectedDay}</DialogDescription></DialogHeader>
        {reservation ? <>
          <Select value={reservation.carId} onValueChange={(carId) => onChange({ ...reservation, carId })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{cars.map((car) => <SelectItem key={car.id} value={car.id}>{car.name}</SelectItem>)}</SelectContent></Select>
          <div className="flex gap-2"><TimeField15 min="00:00" aria-label={he.sadranRideSheet.depart} value={reservation.start} onChange={(start) => onChange({ ...reservation, start })} /><TimeField15 min="00:00" max="23:59" aria-label={he.sadranRideSheet.return} value={reservation.end} onChange={(end) => onChange({ ...reservation, end })} /></div>
          <Textarea aria-label={he.sadranBoard.reservationNotes} placeholder={he.sadranBoard.reservationNotes} value={reservation.notes} onChange={(event) => onChange({ ...reservation, notes: event.target.value })} />
          <div className="space-y-1">
            <p className="text-sm font-medium">{he.sadranBoard.reservationPeople}</p>
            <p className="text-xs text-muted-foreground">{he.sadranBoard.reservationPeopleHint}</p>
            <CompanionPicker
              members={members.map((m) => ({ id: m.id, name: m.name }))}
              value={reservation.memberIds}
              onChange={(memberIds) => onChange({ ...reservation, memberIds })}
            />
          </div>
          <div className="space-y-1">
            <CompanionPicker
              members={children.map((child) => ({
                id: child.id,
                name: child.age == null ? child.name : `${child.name} · ${child.age}`,
              }))}
              value={reservation.childIds}
              onChange={(childIds) => onChange({ ...reservation, childIds })}
              label={he.sadranBoard.reservationChildren}
            />
          </div>
          <Button disabled={saving || !reservation.notes.trim() || !reservation.carId} onClick={onSave}>{he.common.save}</Button>
        </> : null}
      </PortalDialogContent>
    </Dialog>
  );
}
