import { useState } from "react";
import { Button } from "@/components/ui/button";
import { TimeField15 } from "@/components/TimeField15";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Car } from "@/features/fleet/api";
import { he } from "@/i18n/he";
import { dateKey, formatTime } from "@/lib/time";
import { siddurCarName } from "@/lib/siddurCarName";
import type { BoardRide, RideMove } from "../api";
import { moveOnRideDay } from "../rideEditing";

export function MemberRideEditor({ ride, cars, saving, onSave }: {
  ride: BoardRide; cars: readonly Car[]; saving: boolean; onSave: (move: RideMove) => void;
}) {
  const [carId, setCarId] = useState(ride.car_id ?? "");
  const [start, setStart] = useState(formatTime(new Date(ride.starts_at!)));
  const [end, setEnd] = useState(dateKey(ride.starts_at!) === dateKey(ride.ends_at!)
    ? formatTime(new Date(ride.ends_at!)) : "23:59");
  const minutes = (value: string) => value.split(":").reduce((h, m) => h * 60 + Number(m), 0);
  const endMinutes = minutes(end);
  const valid = !!carId && !!start && !!end && endMinutes > minutes(start) && endMinutes <= 1439;
  return (
    <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => {
      e.preventDefault();
      const move = moveOnRideDay(ride, carId, minutes(start), endMinutes);
      if (valid && move) onSave(move);
    }}>
      <h3 className="font-medium">{he.rideEditing.edit}</h3>
      <Select value={carId} onValueChange={setCarId}>
        <SelectTrigger aria-label={he.rideDetail.car}><SelectValue /></SelectTrigger>
        <SelectContent>{cars.filter((c) => c.status === "active" && (c.type === "shared" || c.owner_id === ride.driver_id)).map((c) => <SelectItem key={c.id} value={c.id}>{siddurCarName(c)}</SelectItem>)}</SelectContent>
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <div><Label>{he.field.depart}</Label><TimeField15 min="00:00" aria-label={he.field.depart} value={start} onChange={setStart} /></div>
        <div><Label>{he.field.return}</Label><TimeField15 min="00:00" max="23:59" aria-label={he.field.return} value={end} onChange={setEnd} /></div>
      </div>
      {!valid ? <p className="text-xs text-destructive">{he.rideEditing.invalidTime}</p> : null}
      <Button disabled={!valid || saving} type="submit" className="w-full">{he.common.save}</Button>
    </form>
  );
}
