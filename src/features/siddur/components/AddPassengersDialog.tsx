import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { FormDialog } from "@/components/FormDialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { fetchChildren } from "@/features/requests/api";
import { useSession } from "@/features/auth/useSession";
import { he, t } from "@/i18n/he";

import { buildAddPassengerInputs } from "../addPassengers";
import { useAddRidePassengersMutation } from "../hooks";

/**
 * The "+ נוסעים" button (siddur `RideDetailSheet`, board `RideSheet`; REQ §13.85, owner
 * decisions 2026-09-09/2026-09-14): any department member may add named passengers — self,
 * companions, children, or free-text guests — to any published ride, including a private
 * car (posting it means willing to share). Self-contained like `RidePassengersEditor`/
 * `RidePublicNotesEditor` (owns its own queries + mutation); unlike `RidePassengersEditor`
 * (which *replaces* a Sadran reservation's whole people list via `set_ride_passengers()`),
 * this only *appends* via `add_ride_passengers()` and never touches the driver.
 */
export function AddPassengersDialog({ rideId, expectedVersion, departmentId, weekStart, disabled }: {
  rideId: string;
  expectedVersion: number;
  departmentId: string;
  weekStart: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [childIds, setChildIds] = useState<string[]>([]);
  const [guestNames, setGuestNames] = useState("");

  const { session } = useSession();
  const profileId = session?.user.id;
  const membersQuery = useDepartmentMembers(departmentId);
  const referenceYear = Number(weekStart.slice(0, 4));
  const childrenQuery = useQuery({
    queryKey: ["children", departmentId, profileId, referenceYear],
    queryFn: () => fetchChildren(departmentId, profileId as string, referenceYear),
    enabled: open && !!departmentId && !!profileId,
  });
  const mutation = useAddRidePassengersMutation();

  function reset() {
    setMemberIds([]);
    setChildIds([]);
    setGuestNames("");
  }

  function submit() {
    const passengers = buildAddPassengerInputs(memberIds, childIds, guestNames, membersQuery.data ?? [], childrenQuery.data ?? []);
    if (!passengers.length) return;
    mutation.mutate(
      { rideId, expectedVersion, passengers },
      {
        onSuccess: () => {
          toast.success(he.addPassengers.added);
          reset();
          setOpen(false);
        },
      },
    );
  }

  const hasPick = memberIds.length > 0 || childIds.length > 0 || guestNames.trim().length > 0;

  return (
    <>
      <Button type="button" variant="outline" className="w-full" disabled={disabled} onClick={() => setOpen(true)}>
        {he.addPassengers.button}
      </Button>
      <FormDialog
        open={open}
        onOpenChange={(next) => { if (!mutation.isPending) { setOpen(next); if (!next) reset(); } }}
        title={he.addPassengers.title}
        onSubmit={submit}
        submitLabel={he.addPassengers.submit}
        loading={mutation.isPending}
        submitDisabled={!hasPick}
      >
        <div className="space-y-4">
          <CompanionPicker
            members={(membersQuery.data ?? []).map((m) => ({ id: m.id, name: m.name }))}
            value={memberIds}
            onChange={setMemberIds}
          />
          <CompanionPicker
            members={(childrenQuery.data ?? []).map((child) => ({
              id: child.id,
              name: child.age == null ? child.name : `${child.name} · ${child.age}`,
            }))}
            value={childIds}
            onChange={setChildIds}
            label={t("field.children")}
          />
          <div className="space-y-1">
            <Label htmlFor="add-passengers-guest-names">{t("quickRequest.guestPassengers")}</Label>
            <Textarea id="add-passengers-guest-names" value={guestNames} onChange={(e) => setGuestNames(e.target.value)} rows={2} />
            <p className="text-xs text-muted-foreground">{t("quickRequest.guestPassengersHelp")}</p>
          </div>
        </div>
      </FormDialog>
    </>
  );
}
