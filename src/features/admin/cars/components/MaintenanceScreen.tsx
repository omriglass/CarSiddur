import { fromZonedTime, formatInTimeZone } from "date-fns-tz";
import { Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";
import { showErrorToast } from "@/lib/rpc";

import { useCarsAdmin } from "../hooks";
import { useCreateMaintenanceBlockMutation, useEndMaintenanceBlockMutation, useMaintenanceBlocks } from "../hooks";

function toIso(date: string, time: string): string {
  return fromZonedTime(`${date}T${time}:00`, TZ).toISOString();
}

function formatDateTime(iso: string): string {
  return formatInTimeZone(new Date(iso), TZ, "dd/MM/yyyy HH:mm");
}

function NewBlockDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const carsQuery = useCarsAdmin();
  const createMutation = useCreateMaintenanceBlockMutation();

  const [carId, setCarId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [fromTime, setFromTime] = useState("08:00");
  const [toDate, setToDate] = useState("");
  const [toTime, setToTime] = useState("17:00");
  const [reason, setReason] = useState("");

  async function submit() {
    const car = (carsQuery.data ?? []).find((c) => c.id === carId);
    if (!car || !fromDate || !toDate || !reason.trim()) return;
    try {
      await createMutation.mutateAsync({
        carId,
        departmentId: car.department_id,
        startsAt: toIso(fromDate, fromTime),
        endsAt: toIso(toDate, toTime),
        reason: reason.trim(),
      });
      toast.success(he.adminCommon.savedToast);
      onOpenChange(false);
      setCarId("");
      setFromDate("");
      setToDate("");
      setReason("");
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{he.adminMaintenance.new}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            {he.adminMaintenance.fieldCar}
            <Select value={carId} onValueChange={setCarId}>
              <SelectTrigger>
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
          </label>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {he.adminMaintenance.fieldFrom}
              <Input type="date" dir="ltr" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <TimeField15 value={fromTime} onChange={setFromTime} />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1 text-sm">
              {he.adminMaintenance.fieldTo}
              <Input type="date" dir="ltr" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
            <TimeField15 value={toTime} onChange={setToTime} />
          </div>
          <label className="flex flex-col gap-1 text-sm">
            {he.adminMaintenance.fieldReason}
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {he.adminCommon.cancel}
          </Button>
          <Button onClick={submit}>{he.adminCommon.save}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MaintenanceScreen() {
  const blocksQuery = useMaintenanceBlocks();
  const carsQuery = useCarsAdmin();
  const endMutation = useEndMaintenanceBlockMutation();
  const [dialogOpen, setDialogOpen] = useState(false);

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
          <Button onClick={() => setDialogOpen(true)}>
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
              <TableHead>{he.adminMaintenance.fieldFrom}</TableHead>
              <TableHead>{he.adminMaintenance.fieldTo}</TableHead>
              <TableHead>{he.adminMaintenance.fieldReason}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {blocks.map((block) => (
              <TableRow key={block.id}>
                <TableCell>{carsById.get(block.car_id) ?? block.car_id}</TableCell>
                <TableCell dir="ltr">{formatDateTime(block.starts_at)}</TableCell>
                <TableCell dir="ltr">{formatDateTime(block.ends_at)}</TableCell>
                <TableCell>{block.reason}</TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await endMutation.mutateAsync(block.id);
                        toast.success(he.adminMaintenance.endedToast);
                      } catch (error) {
                        showErrorToast(error);
                      }
                    }}
                  >
                    {he.adminMaintenance.end}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <NewBlockDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
