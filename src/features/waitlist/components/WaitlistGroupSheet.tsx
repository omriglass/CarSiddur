import { useState } from "react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he, tv } from "@/i18n/he";
import { weekdayLabel } from "@/lib/dayLabels";
import { showErrorToast } from "@/lib/rpc";
import { formatTime } from "@/lib/time";

import { useCancelWaitlistGroupMutation, useResolveWaitlistGroupMutation } from "../hooks";
import { orderedSelection } from "../orderedSelection";
import type { WaitlistGroup } from "../types";

interface WaitlistGroupSheetProps {
  group: WaitlistGroup | null;
  departmentId: string;
  weekStart: string;
  /** The signed-in member's own profile id — a group member (`resolve_waitlist_group()`'s "open member of the group") can resolve even without `canManageWeek`. */
  profileId: string | undefined;
  /** `can_manage_week` — the Sadran (or admin) of this week; also gates the "בטל/י את הדיון" action. */
  canManageWeek: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Resolution sheet for one contested waiting-list group (UX_FLOWS.md
 * §3.5/§4.2, REQ §13.75): every participant, or the Sadran, ticks who rides
 * and picks the driver among the ticked; the rest stay on the waiting list.
 * Follows `RideDetailSheet.tsx`'s bottom-sheet pattern.
 */
export function WaitlistGroupSheet({ group, departmentId, weekStart, profileId, canManageWeek, onOpenChange }: WaitlistGroupSheetProps) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [driverId, setDriverId] = useState<string | null>(null);
  const [confirmResolve, setConfirmResolve] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const resolveMutation = useResolveWaitlistGroupMutation(departmentId, weekStart);
  const cancelMutation = useCancelWaitlistGroupMutation(departmentId, weekStart);

  const canResolve = !!group && (canManageWeek || group.members.some((member) => member.profile_id === profileId));
  const tickedIds = group ? group.members.map((member) => member.request_id).filter((id) => ticked.has(id)) : [];
  // "Defaulting to the first ticked" (brief): re-derived every render instead of an effect, same
  // idiom `SiddurPage`'s notification-deep-link handling uses for "adjust state for freshly
  // arrived data".
  const effectiveDriver = driverId && tickedIds.includes(driverId) ? driverId : (tickedIds[0] ?? null);
  const seats = group
    ? group.members.filter((member) => ticked.has(member.request_id)).reduce((sum, member) => sum + member.adults + member.child_seats + member.boosters, 0)
    : 0;

  function toggle(requestId: string, checked: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      if (checked) next.add(requestId);
      else next.delete(requestId);
      return next;
    });
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setTicked(new Set());
      setDriverId(null);
    }
    onOpenChange(open);
  }

  async function handleResolve() {
    if (!group || !effectiveDriver) return;
    try {
      await resolveMutation.mutateAsync({
        groupId: group.id,
        requestIds: orderedSelection(tickedIds, effectiveDriver),
        expectedVersion: group.version,
      });
      toast.success(he.waitlist.resolved);
      setConfirmResolve(false);
      handleOpenChange(false);
    } catch (error) {
      showErrorToast(error);
    }
  }

  async function handleCancel() {
    if (!group) return;
    try {
      await cancelMutation.mutateAsync({ groupId: group.id, expectedVersion: group.version });
      setConfirmCancel(false);
      handleOpenChange(false);
    } catch (error) {
      showErrorToast(error);
    }
  }

  const destinations = group ? Array.from(new Set(group.members.map((member) => member.destination))).join(", ") : "";
  const driverName = group?.members.find((member) => member.request_id === effectiveDriver)?.name ?? "";
  const otherNames = group
    ? group.members.filter((member) => ticked.has(member.request_id) && member.request_id !== effectiveDriver).map((member) => member.name).join(", ")
    : "";

  return (
    <>
      <Sheet open={!!group} onOpenChange={handleOpenChange}>
        <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
          {group ? (
            <>
              <SheetHeader>
                <SheetTitle>{he.waitlist.sheetTitle}</SheetTitle>
              </SheetHeader>
              <div className="space-y-4 py-4 text-sm">
                <p className="text-muted-foreground">
                  {weekdayLabel(`${group.day}T12:00:00Z`)} ·{" "}
                  <span dir="ltr">{formatTime(new Date(group.starts_at))}–{formatTime(new Date(group.ends_at))}</span> · {destinations}
                </p>

                <ul className="space-y-3">
                  {group.members.map((member) => (
                    <li key={member.request_id} className="flex items-start gap-2">
                      {canResolve ? (
                        <Checkbox
                          className="mt-1"
                          checked={ticked.has(member.request_id)}
                          onCheckedChange={(checked) => toggle(member.request_id, !!checked)}
                          aria-label={member.name}
                        />
                      ) : null}
                      <div className="flex-1 space-y-0.5">
                        <p className="font-medium">{member.name}</p>
                        <p className="text-xs text-muted-foreground">
                          <span dir="ltr">{formatTime(new Date(member.depart_at))}–{formatTime(new Date(member.return_at))}</span> · {member.destination}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {tv("waitlist.seatsLine", { adults: String(member.adults), childSeats: String(member.child_seats), boosters: String(member.boosters) })}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>

                {canResolve ? (
                  <>
                    {tickedIds.length > 0 ? (
                      <div className="space-y-2">
                        <p className="font-medium">{he.waitlist.driver}</p>
                        <RadioGroup value={effectiveDriver ?? undefined} onValueChange={setDriverId}>
                          {group.members.filter((member) => ticked.has(member.request_id)).map((member) => (
                            <label key={member.request_id} className="flex items-center gap-2">
                              <RadioGroupItem value={member.request_id} />
                              <span>{member.name}</span>
                            </label>
                          ))}
                        </RadioGroup>
                      </div>
                    ) : null}
                    <p className="font-medium">{tv("waitlist.summary", { count: String(tickedIds.length), seats: String(seats) })}</p>
                    <Button className="w-full" size="lg" disabled={!tickedIds.length} onClick={() => setConfirmResolve(true)}>
                      {he.waitlist.confirm}
                    </Button>
                    {canManageWeek ? (
                      <Button className="w-full" size="lg" variant="destructive" onClick={() => setConfirmCancel(true)}>
                        {he.waitlist.cancelGroup}
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <p className="text-muted-foreground">{he.waitlist.readOnlyHint}</p>
                )}
              </div>
            </>
          ) : null}
        </PortalSheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmResolve}
        onOpenChange={setConfirmResolve}
        title={he.waitlist.confirm}
        description={tv("waitlist.confirmBody", { driver: driverName, names: otherNames || driverName })}
        confirmLabel={he.waitlist.confirm}
        loading={resolveMutation.isPending}
        onConfirm={() => void handleResolve()}
      />
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title={he.waitlist.cancelGroup}
        description={he.waitlist.cancelGroupBody}
        destructive
        loading={cancelMutation.isPending}
        onConfirm={() => void handleCancel()}
      />
    </>
  );
}
