import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormDialog } from "@/components/FormDialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { Car } from "@/features/admin/cars/api";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useProfile } from "@/features/auth/useProfile";
import { he, tv } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useSetCarPrivateMutation, useUpcomingCarRidesQuery } from "../hooks";
import { ridesNeedingWarning } from "../lib/privateCar";

interface Props {
  car: Car;
  /** Admin, the car's responsible person or the department's Sadran (RLS re-checks). */
  canEdit: boolean;
}

/** "רכב פרטי (מושאל)" state line + switch on the car page (UX_FLOWS §5.11). The switch shows for editors only. */
export function CarPrivateSwitch({ car, canEdit }: Props) {
  const profile = useProfile().data;
  const membersQuery = useDepartmentMembers(car.department_id);
  const mutation = useSetCarPrivateMutation();
  const isPrivate = car.type === "temporary";
  const [turnOnOpen, setTurnOnOpen] = useState(false);
  const [turnOffOpen, setTurnOffOpen] = useState(false);
  const [pickedOwner, setPickedOwner] = useState<string | null>(null);

  // useDepartmentMembers leaves the viewer out; add them back so they can pick themselves.
  const options = [
    ...(profile ? [{ id: profile.id, name: profile.full_name }] : []),
    ...(membersQuery.data ?? []).map((m) => ({ id: m.id, name: m.name })),
  ];
  const ownerId = pickedOwner ?? car.responsible_id ?? null;
  const ownerName = options.find((o) => o.id === car.owner_id)?.name ?? null;

  const upcomingQuery = useUpcomingCarRidesQuery(car.id, turnOnOpen);
  const warnCount = ridesNeedingWarning(upcomingQuery.data ?? [], ownerId).length;

  async function save(next: string | null, close: () => void) {
    try {
      await mutation.mutateAsync({ car, ownerId: next });
      toast.success(next ? he.carPage.privateSavedOn : he.carPage.privateSavedOff);
      close();
    } catch (error) {
      showErrorToast(error);
    }
  }

  if (!isPrivate && !canEdit) return null;

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border p-3" data-testid="car-private-card">
      <div className="text-sm">
        <Label htmlFor="car-private-switch">{he.carPage.privateSwitchLabel}</Label>
        {isPrivate ? (
          <p className="text-muted-foreground" data-testid="car-private-state">
            {ownerName ? tv("carPage.privateStateOn", { name: ownerName }) : he.carPage.privateStateOnNoName}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <Switch
          id="car-private-switch"
          checked={isPrivate}
          disabled={mutation.isPending}
          onCheckedChange={(checked) => {
            if (checked) {
              setPickedOwner(null);
              setTurnOnOpen(true);
            } else {
              setTurnOffOpen(true);
            }
          }}
        />
      ) : null}

      <FormDialog
        open={turnOnOpen}
        onOpenChange={setTurnOnOpen}
        title={he.carPage.privateTurnOnTitle}
        description={he.carPage.privateTurnOnDescription}
        submitLabel={he.carPage.privateTurnOnSubmit}
        loading={mutation.isPending}
        submitDisabled={!ownerId}
        onSubmit={() => void save(ownerId, () => setTurnOnOpen(false))}
      >
        <div className="space-y-2">
          <Label>{he.carPage.privateOwnerLabel}</Label>
          <Select value={ownerId ?? ""} onValueChange={setPickedOwner}>
            <SelectTrigger data-testid="car-private-owner">
              <SelectValue placeholder={he.carPage.privateOwnerPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.id === profile?.id ? tv("carPage.privateOwnerMe", { name: o.name }) : o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {warnCount > 0 ? (
            <p className="rounded-md border border-maintenance/40 bg-maintenance/10 p-2 text-sm" role="alert" data-testid="car-private-warning">
              {tv("carPage.privateUpcomingWarning", { count: String(warnCount) })}
            </p>
          ) : null}
        </div>
      </FormDialog>

      <ConfirmDialog
        open={turnOffOpen}
        onOpenChange={setTurnOffOpen}
        title={he.carPage.privateTurnOffTitle}
        description={he.carPage.privateTurnOffDescription}
        confirmLabel={he.carPage.privateTurnOffConfirm}
        loading={mutation.isPending}
        onConfirm={() => void save(null, () => setTurnOffOpen(false))}
      />
    </div>
  );
}
