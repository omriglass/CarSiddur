import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Car } from "@/features/admin/cars/api";
import { he } from "@/i18n/he";
import { CAR_STATUSES } from "@/lib/enums";
import { showErrorToast } from "@/lib/rpc";

import { useSetCarStatusMutation } from "../hooks";

/**
 * A car administrator's only control on a PRIVATE car (REQ item 150 a): its status. Everything else on the page stays
 * read-only for them; the server (trigger) refuses any other field.
 */
export function CarStatusSelect({ car }: { car: Car }) {
  const mutation = useSetCarStatusMutation();
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="car-status-card">
      <Label>{he.carChecklist.privateStatus.label}</Label>
      <p className="text-xs text-muted-foreground">{he.carChecklist.privateStatus.help}</p>
      <Select
        value={car.status}
        disabled={mutation.isPending}
        onValueChange={(value) =>
          mutation.mutate(
            { carId: car.id, status: value as Car["status"] },
            { onSuccess: () => toast.success(he.carChecklist.privateStatus.saved), onError: showErrorToast },
          )
        }
      >
        <SelectTrigger data-testid="car-status-select"><SelectValue /></SelectTrigger>
        <SelectContent>
          {CAR_STATUSES.map((status) => <SelectItem key={status} value={status}>{he.car.status[status]}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
