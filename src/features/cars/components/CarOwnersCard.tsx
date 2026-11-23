import { X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Car } from "@/features/admin/cars/api";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { useProfile } from "@/features/auth/useProfile";
import { he, tv } from "@/i18n/he";
import { carOwnerIds, isCarOwner } from "@/lib/carOwners";
import { CAR_USE_SCOPES, type CarUseScope } from "@/lib/enums";
import { showErrorToast } from "@/lib/rpc";

import { useCarOwnerMutation, useCarUseScopeMutation } from "../hooks";

/**
 * PC1 (REQ item 227 b): the owners of a private car, at the top of its page. Any owner, the department's Sadran or an
 * admin (`canManageOwners`) adds an approved department member or removes an owner; the last owner stays (the server
 * refuses with `car_last_owner`; turning the car shared is the way to give it back).
 */
export function CarOwnersCard({ car, canManageOwners }: { car: Car; canManageOwners: boolean }) {
  const profile = useProfile().data;
  const membersQuery = useDepartmentMembers(car.department_id, { includeSelf: true });
  const mutation = useCarOwnerMutation();
  const scopeMutation = useCarUseScopeMutation();
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  if (car.type !== "temporary") return null;
  const ownerIds = carOwnerIds(car);
  const nameOf = (id: string) => (membersQuery.data ?? []).find((m) => m.id === id)?.name ?? "";
  const mayManage = canManageOwners || isCarOwner(car, profile?.id);
  const candidates = (membersQuery.data ?? []).filter((m) => !ownerIds.includes(m.id));
  const isOwner = isCarOwner(car, profile?.id);
  const label = (id: string) => (id === profile?.id ? tv("carPage.ownersMe", { name: nameOf(id) }) : nameOf(id));

  async function add() {
    if (!picked) return;
    try {
      await mutation.mutateAsync({ carId: car.id, profileId: picked });
      toast.success(he.carPage.ownerAdded);
      setAddOpen(false);
      setPicked(null);
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function setScope(scope: CarUseScope) {
    try {
      await scopeMutation.mutateAsync({ carId: car.id, scope });
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function remove() {
    if (!removing) return;
    try {
      await mutation.mutateAsync({ carId: car.id, profileId: removing.id, remove: true });
      toast.success(he.carPage.ownerRemoved);
      setRemoving(null);
    } catch (error) {
      showErrorToast(error);
    }
  }

  return (
    <Card data-testid="car-owners-card">
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{he.carPage.ownersTitle}</h2>
          {mayManage ? (
            <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)} data-testid="car-owners-add">
              {he.carPage.ownersAdd}
            </Button>
          ) : null}
        </div>
        {ownerIds.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="car-owners-none">{he.carPage.ownersNone}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {ownerIds.map((id) => (
              <li key={id} className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm" data-testid="car-owner">
                {label(id)}
                {mayManage && ownerIds.length > 1 ? (
                  <button
                    type="button"
                    className="-me-1 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
                    aria-label={tv("carPage.ownersRemove", { name: nameOf(id) })}
                    onClick={() => setRemoving({ id, name: nameOf(id) })}
                    data-testid="car-owner-remove"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {mayManage && ownerIds.length === 1 ? <p className="text-xs text-muted-foreground">{he.carPage.ownersLastHint}</p> : null}
        {/* PE1 (REQ item 263): who else may use the car - an owner's setting */}
        {isOwner ? (
          <div className="space-y-1 border-t pt-2">
            <Label htmlFor={`car-use-scope-${car.id}`}>{he.carPage.useScopeTitle}</Label>
            <Select
              value={car.use_scope}
              onValueChange={(value) => void setScope(value as CarUseScope)}
              disabled={scopeMutation.isPending}
            >
              <SelectTrigger id={`car-use-scope-${car.id}`} data-testid="car-use-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAR_USE_SCOPES.map((scope) => (
                  <SelectItem key={scope} value={scope} data-testid={`car-use-scope-${scope}`}>{he.carPage.useScopeOptions[scope]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{he.carPage.useScopeHelp}</p>
          </div>
        ) : null}
      </CardContent>

      <FormDialog
        open={addOpen}
        onOpenChange={(open) => { setAddOpen(open); if (!open) setPicked(null); }}
        title={he.carPage.ownersAddTitle}
        description={he.carPage.ownersAddDescription}
        submitLabel={he.carPage.ownersAddSubmit}
        loading={mutation.isPending}
        submitDisabled={!picked}
        onSubmit={() => void add()}
      >
        <div className="space-y-2">
          <Label>{he.carPage.ownersPick}</Label>
          <Select value={picked ?? ""} onValueChange={setPicked}>
            <SelectTrigger data-testid="car-owners-pick">
              <SelectValue placeholder={he.carPage.ownersPick} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((m) => (
                <SelectItem key={m.id} value={m.id}>{label(m.id)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title={tv("carPage.ownersRemoveTitle", { name: removing?.name ?? "" })}
        confirmLabel={he.carPage.ownersRemoveConfirm}
        loading={mutation.isPending}
        onConfirm={() => void remove()}
      />
    </Card>
  );
}
