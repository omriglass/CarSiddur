import { useActiveDepartment } from "@/features/auth/useActiveDepartment";
import { useSearchParams } from "react-router-dom";

import { formatWeekRangeLabel } from "@/components/DateField";
import { PageHeader } from "@/components/PageHeader";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { resolveWeekStart } from "@/features/requests/resolveWeekStart";
import { RequestForm, type JoinRidePrefill } from "@/features/requests/components/RequestForm";
import { useCarForRide, useBoardRideById, useWeeks } from "@/features/siddur/hooks";
import { he } from "@/i18n/he";

/**
 * `/requests/new` (UX_FLOWS.md §3.4). `?ride=<id>` prefills an "ask to join"
 * request against that ride (§3.5, REQ §7.3, §13.43).
 */
export function NewRequestPage() {
  const [searchParams] = useSearchParams();
  const joinRideId = searchParams.get("ride") ?? undefined;
  const weekOverride = searchParams.get("week") ?? undefined;
  // Quick-request-from-empty-slot on an Open/Solving-week siddur (UX_FLOWS.md §18): the
  // Sadran hasn't solved yet, so there is no car to target — only day/time carry over.
  const dayParam = searchParams.get("day") ?? undefined;
  const timeParam = searchParams.get("time") ?? undefined;
  const waitlist = searchParams.get("waitlist") === "1";

  const profileQuery = useProfile();
  const departmentsQuery = useMyDepartments();
  const active = useActiveDepartment();
  const departmentId = active.departmentId;
  const weeksQuery = useWeeks(departmentId);
  const weekStart = resolveWeekStart(weeksQuery.data ?? [], weekOverride);

  const rideQuery = useBoardRideById(joinRideId);
  const carQuery = useCarForRide(rideQuery.data?.car_id ?? undefined);

  const isLoading =
    active.isLoading || profileQuery.isLoading || departmentsQuery.isLoading || weeksQuery.isLoading || (!!joinRideId && (rideQuery.isLoading || carQuery.isLoading));

  const joinRide: JoinRidePrefill | undefined =
    joinRideId && rideQuery.data && carQuery.data
      ? {
          rideId: joinRideId,
          driverName: rideQuery.data.driver_name ?? "",
          carType: carQuery.data.type,
          isRelay: rideQuery.data.origin_id !== rideQuery.data.destination_id,
          destinationId: rideQuery.data.destination_id,
          destinationName: rideQuery.data.destination_name ?? "",
          startsAt: rideQuery.data.starts_at ?? new Date().toISOString(),
          endsAt: rideQuery.data.ends_at ?? new Date().toISOString(),
        }
      : undefined;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="p-4 pb-0">
        <PageHeader
          title={he.screen.request.new}
          subtitle={weekStart ? formatWeekRangeLabel(weekStart) : undefined}
        />
      </div>
      {!isLoading && !active.canSubmit ? <p className="p-4">{he.departmentContext.noMembership}</p> : isLoading || !departmentId || !weekStart ? (
        <div className="space-y-3 p-4">
          <div className="h-11 animate-pulse rounded-md bg-muted" />
          <div className="h-11 animate-pulse rounded-md bg-muted" />
        </div>
      ) : (
        <RequestForm
          mode="new"
          departmentId={departmentId}
          weekStart={weekStart}
          joinRide={joinRide}
          slotPrefill={!joinRideId && dayParam && timeParam ? { day: dayParam, departTime: timeParam } : undefined}
          waitlist={waitlist}
        />
      )}
    </div>
  );
}
