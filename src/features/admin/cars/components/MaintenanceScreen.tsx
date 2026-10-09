import { Plus } from "lucide-react";
import { useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { FormDialog } from "@/components/FormDialog";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MaintenancePeriodDialog, type MaintenancePeriodDialogTarget } from "@/features/fleet/components/MaintenancePeriodDialog";
import { formatMaintenanceRange } from "@/features/fleet/maintenance";
import { he } from "@/i18n/he";

import { useCarsAdmin, useMaintenanceBlocks } from "../hooks";

/** Stored reason codes → copy; a free-text reason (older rows) is shown as typed. */
function reasonLabel(reason: string): string {
  if (reason === "UNSAFE_ISSUE") return he.maintenancePeriod.reasonUnsafeIssue;
  if (reason === "SCHEDULED") return he.maintenancePeriod.reasonScheduled;
  return reason;
}

/**
 * `/admin/maintenance` (UX_FLOWS §5.5, REQ §13.114): the department's maintenance periods. New / edit / cancel
 * all go through the shared `MaintenancePeriodDialog` (server-checked RPCs).
 */
export function MaintenanceScreen() {
  const blocksQuery = useMaintenanceBlocks();
  const carsQuery = useCarsAdmin();
  const [pickingCar, setPickingCar] = useState(false);
  const [pickedCarId, setPickedCarId] = useState("");
  const [target, setTarget] = useState<MaintenancePeriodDialogTarget | null>(null);

  const carsById = new Map((carsQuery.data ?? []).map((c) => [c.id, c.name]));
  // `Date.now()` read once via a lazy initializer (not on every render) —
  // react-hooks/purity forbids calling it directly in the render body.
  const [now] = useState(() => Date.now());
  const blocks = (blocksQuery.data ?? []).filter((b) => new Date(b.ends_at).getTime() > now);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <PageHeader
        title={he.screen.admin.maintenance}
        subtitle={he.adminMaintenance.subtitle}
        actions={
          <Button onClick={() => setPickingCar(true)}>
            <Plus className="me-1 size-4" /> {he.action.addBlock}
          </Button>
        }
      />

      {blocks.length === 0 ? (
        <EmptyState icon={Plus} message={he.adminMaintenance.empty} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{he.adminMaintenance.fieldCar}</TableHead>
              <TableHead>{he.maintenancePeriod.title}</TableHead>
              <TableHead>{he.adminMaintenance.fieldReason}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {blocks.map((block) => (
              <TableRow key={block.id}>
                <TableCell>{carsById.get(block.car_id) ?? block.car_id}</TableCell>
                <TableCell>{formatMaintenanceRange(block.starts_at, block.ends_at)}</TableCell>
                <TableCell>{reasonLabel(block.reason)}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setTarget({ mode: "edit", carName: carsById.get(block.car_id) ?? "", block })}
                  >
                    {he.adminMaintenance.edit}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <FormDialog
        open={pickingCar}
        onOpenChange={setPickingCar}
        title={he.adminMaintenance.pickCarTitle}
        submitDisabled={!pickedCarId}
        onSubmit={() => {
          setTarget({ mode: "create", carId: pickedCarId, carName: carsById.get(pickedCarId) ?? "" });
          setPickingCar(false);
          setPickedCarId("");
        }}
      >
        <Select value={pickedCarId} onValueChange={setPickedCarId}>
          <SelectTrigger aria-label={he.adminMaintenance.fieldCar}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(carsQuery.data ?? []).map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormDialog>

      <MaintenancePeriodDialog target={target} onOpenChange={(open) => !open && setTarget(null)} />
    </div>
  );
}
