import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";

import { useCanEditMaintenance, useMaintenanceBlocks } from "../hooks";
import { formatMaintenanceRange, nextMaintenance } from "../maintenance";
import { MaintenancePeriodDialog, type MaintenancePeriodDialogTarget } from "./MaintenancePeriodDialog";

interface Props {
  car: { id: string; name: string; department_id: string; responsible_id: string | null };
}

/**
 * Car page block (REQ §13.114, UX_FLOWS §5.11): "טיפול הבא: ד׳ 12.11 10:00–19:00", the upcoming periods with
 * edit, and the "תקופת טיפול" button. Whoever may open the car page may edit (admin, the department's Sadran,
 * the responsible person) — `useCanEditMaintenance` mirrors the server rule that re-checks every write.
 */
export function CarMaintenancePanel({ car }: Props) {
  const blocksQuery = useMaintenanceBlocks(car.department_id);
  const canEdit = useCanEditMaintenance(car.department_id)(car);
  const [target, setTarget] = useState<MaintenancePeriodDialogTarget | null>(null);
  // Read once: render must stay pure (react-hooks/purity).
  const [now] = useState(() => Date.now());

  const upcoming = (blocksQuery.data ?? []).filter((b) => b.car_id === car.id && Date.parse(b.ends_at) > now);
  const next = nextMaintenance(upcoming, car.id, now);

  return (
    <section className="rounded-md border p-3" data-testid="car-maintenance-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm" data-testid="car-next-maintenance">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {next ? tv("maintenancePeriod.next", { range: formatMaintenanceRange(next.starts_at, next.ends_at) }) : he.maintenancePeriod.none}
        </p>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setTarget({ mode: "create", carId: car.id, carName: car.name })} data-testid="car-add-maintenance">
            {he.maintenancePeriod.action}
          </Button>
        ) : null}
      </div>
      {upcoming.length > 1 || (upcoming.length === 1 && canEdit) ? (
        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
          {upcoming.map((b) => (
            <li key={b.id} className="flex items-center justify-between gap-2">
              <span>{formatMaintenanceRange(b.starts_at, b.ends_at)}</span>
              {canEdit ? (
                <Button size="sm" variant="ghost" onClick={() => setTarget({ mode: "edit", carName: car.name, block: b })}>
                  {he.adminMaintenance.edit}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <MaintenancePeriodDialog target={target} onOpenChange={(open) => !open && setTarget(null)} />
    </section>
  );
}
