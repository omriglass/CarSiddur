import { useCallback, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { tv } from "@/i18n/he";

import { MaintenancePeriodDialog, type MaintenancePeriodDialogTarget } from "./components/MaintenancePeriodDialog";
import { useCanEditMaintenance, useUpdateCarMaintenanceMutation } from "./hooks";
import { formatMaintenanceRange, maintenanceDaySlice, shiftMaintenance, type MaintenanceEdge, type MaintenancePeriod } from "./maintenance";

import type { WeekGridBlock } from "@/components/WeekGrid";

interface GridCar {
  id: string;
  name: string;
  responsible_id?: string | null;
}

/**
 * Maintenance bands on a siddur / board `WeekGrid` (REQ §13.114): the bands of one day, which of them the viewer
 * may drag (the car's current responsible person, the Sadran, the admin — the server re-checks every write), the
 * drag handler (one `update_car_maintenance` call) and the dialog a click opens.
 */
export function useMaintenanceGridEditing(input: {
  departmentId: string | undefined;
  blocks: readonly MaintenancePeriod[];
  cars: readonly GridCar[];
  /** `yyyy-MM-dd` of the grid's day. */
  day: string | null | undefined;
  /** True on the Sadran board (only Sadranim/admins reach it). */
  staff?: boolean;
}): {
  gridBlocks: WeekGridBlock[];
  onBlockChange: (blockId: string, edge: MaintenanceEdge, deltaMinutes: number) => void;
  onBlockClick: (blockId: string) => void;
  dialog: ReactNode;
} {
  const { departmentId, blocks, cars, day, staff = false } = input;
  const canEditCar = useCanEditMaintenance(departmentId, staff);
  const updateMutation = useUpdateCarMaintenanceMutation();
  const [target, setTarget] = useState<MaintenancePeriodDialogTarget | null>(null);
  const carsById = useMemo(() => new Map(cars.map((c) => [c.id, c])), [cars]);

  const gridBlocks = useMemo<WeekGridBlock[]>(() => {
    if (!day) return [];
    return blocks.flatMap((block) => {
      const slice = maintenanceDaySlice(block, day);
      if (!slice) return [];
      return [{
        id: block.id,
        carId: block.car_id,
        startMinutes: slice.startMinutes,
        endMinutes: slice.endMinutes,
        clippedStart: slice.clippedStart,
        clippedEnd: slice.clippedEnd,
        kind: "maintenance" as const,
        label: tv("maintenancePeriod.blockTitle", { range: formatMaintenanceRange(block.starts_at, block.ends_at) }),
        editable: canEditCar(carsById.get(block.car_id)),
      }];
    });
  }, [blocks, day, canEditCar, carsById]);

  const onBlockChange = useCallback(
    (blockId: string, edge: MaintenanceEdge, deltaMinutes: number) => {
      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;
      const next = shiftMaintenance(block, edge, deltaMinutes);
      updateMutation.mutate({ blockId, startsAt: next.startsAt, endsAt: next.endsAt }, {
        onSuccess: (result) => {
          if (result.flagged_rides > 0) toast.warning(tv("maintenancePeriod.flaggedToast", { count: String(result.flagged_rides) }));
        },
      });
    },
    [blocks, updateMutation],
  );

  const onBlockClick = useCallback(
    (blockId: string) => {
      const block = blocks.find((b) => b.id === blockId);
      if (!block) return;
      setTarget({ mode: "edit", carName: carsById.get(block.car_id)?.name ?? "", block });
    },
    [blocks, carsById],
  );

  return {
    gridBlocks,
    onBlockChange,
    onBlockClick,
    dialog: <MaintenancePeriodDialog target={target} onOpenChange={(open) => !open && setTarget(null)} />,
  };
}
