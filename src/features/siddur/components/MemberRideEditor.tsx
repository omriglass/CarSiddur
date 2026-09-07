import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Car } from "@/features/fleet/api";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";
import type { BoardRide, RideMove } from "../api";
import { moveOnRideDay } from "../rideEditing";

export function MemberRideEditor({ ride, cars, saving, onSave }: {
  ride: BoardRide; cars: readonly Car[]; saving: boolean; onSave: (move: RideMove) => void;
}) {
  const [carId, setCarId] = useState(ride.car_id ?? "");
  const [start, setStart] = useState(formatInTimeZone(ride.starts_at!, TZ, "HH:mm"));
  const [end, setEnd] = useState(formatInTimeZone(ride.ends_at!, TZ, "HH:mm"));
  const minutes = (value: string) => value.split(":").reduce((h, m) => h * 60 + Number(m), 0);
  const endMinutes = end === "00:00" ? 1440 : minutes(end);
  const valid = !!carId && !!start && !!end && endMinutes > minutes(start);
  return (
    <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => {
      e.preventDefault();
      const move = moveOnRideDay(ride, carId, minutes(start), endMinutes);
      if (valid && move) onSave(move);
    }}>
      <h3 className="font-medium">{he.rideEditing.edit}</h3>
      <Select value={carId} onValueChange={setCarId}>
        <SelectTrigger aria-label={he.rideDetail.car}><SelectValue /></SelectTrigger>
        <SelectContent>{cars.filter((c) => c.status === "active" && (c.type === "shared" || c.owner_id === ride.driver_id)).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
      </Select>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="member-ride-start">{he.field.depart}</Label><Input id="member-ride-start" type="time" step={900} dir="ltr" required value={start} onChange={(e) => setStart(e.target.value)} /></div>
        <div><Label htmlFor="member-ride-end">{he.field.return}</Label><Input id="member-ride-end" type="time" step={900} dir="ltr" required value={end} onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      {!valid ? <p className="text-xs text-destructive">{he.rideEditing.invalidTime}</p> : null}
      <Button disabled={!valid || saving} type="submit" className="w-full">{he.common.save}</Button>
    </form>
  );
}
