import { formatInTimeZone } from "date-fns-tz";
import { CalendarDays, Inbox } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { formatWeekRangeLabel, todayInJerusalem } from "@/components/DateField";
import { DestinationCombobox, type DestinationValue } from "@/components/DestinationCombobox";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader } from "@/components/PageHeader";
import { RideCard, type RideCardData } from "@/components/RideCard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WeekGrid, type WeekGridCar, type WeekGridRide } from "@/components/WeekGrid";
import { WeekStrip } from "@/components/WeekStrip";
import { useMyDepartments } from "@/features/auth/useMyDepartments";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { useCars, useDestinations } from "@/features/fleet/hooks";
import { RideDetailSheet } from "@/features/siddur/components/RideDetailSheet";
import { groupByDay } from "@/features/siddur/dayGrouping";
import {
  useBoardRides,
  useCarLocations,
  useDepartments,
  useWeeks,
} from "@/features/siddur/hooks";
import type { Week } from "@/features/siddur/api";
import { he, t, tv } from "@/i18n/he";
import { TZ } from "@/lib/time";

/** Live > Published/Archived > soonest Open (UX_FLOWS §3.5: the siddur opens on the relevant week). */
function resolveSiddurWeek(weeks: readonly Week[]): Week | null {
  const live = weeks.find((w) => w.phase === "live");
  if (live) return live;
  const published = [...weeks]
    .filter((w) => w.phase === "published" || w.phase === "archived")
    .sort((a, b) => (a.week_start < b.week_start ? 1 : -1))[0];
  if (published) return published;
  const open = [...weeks].filter((w) => w.phase === "open").sort((a, b) => (a.week_start < b.week_start ? -1 : 1))[0];
  return open ?? null;
}

function minutesSinceMidnight(instant: string): number {
  const [h, m] = formatInTimeZone(new Date(instant), TZ, "HH:mm").split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * `/siddur`, `/siddur/:dept/:week` — published siddur (UX_FLOWS.md §3.5). Day
 * list by default; a read-only `WeekGrid` from `lg` up. Members read other
 * departments' published siddurim too (REQ §13.52) — the department switcher
 * lists every active department, and RLS naturally empties out anything not
 * visible (draft/open weeks of a department I don't belong to).
 */
export function SiddurPage() {
  const params = useParams<{ dept?: string; week?: string }>();
  const navigate = useNavigate();

  const { session } = useSession();
  const profileId = session?.user.id;
  const profileQuery = useProfile();
  const myDepartmentsQuery = useMyDepartments();
  const departmentsQuery = useDepartments();
  const destinationsQuery = useDestinations();

  const defaultDepartmentId =
    profileQuery.data?.default_department_id ?? myDepartmentsQuery.data?.[0]?.department_id;
  const departmentId = params.dept ?? defaultDepartmentId;

  const weeksQuery = useWeeks(departmentId);
  const weeks = weeksQuery.data ?? [];
  const resolvedWeek = params.week ? weeks.find((w) => w.week_start === params.week) ?? null : resolveSiddurWeek(weeks);
  const weekStart = resolvedWeek?.week_start;

  const boardRidesQuery = useBoardRides(departmentId, weekStart);
  const carsQuery = useCars(departmentId);
  const carLocationsQuery = useCarLocations(departmentId, weekStart);

  const [destFilter, setDestFilter] = useState<DestinationValue | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);

  const isMyDepartment = (myDepartmentsQuery.data ?? []).some((d) => d.department_id === departmentId);
  const filterName = destFilter ? ("presetId" in destFilter ? destFilter.name : destFilter.freeText) : null;

  const rides = (boardRidesQuery.data ?? []).filter(
    (r) => !filterName || r.destination_name === filterName || r.origin_name === filterName,
  );

  const dayGroups = weekStart ? groupByDay(rides, weekStart, (r) => r.starts_at ?? "") : [];
  const today = todayInJerusalem();
  const defaultDay = dayGroups.find((g) => g.date === today)?.date ?? dayGroups[0]?.date ?? null;
  const activeDay = selectedDay ?? defaultDay;
  const activeDayRides = dayGroups.find((g) => g.date === activeDay)?.items ?? [];

  const selectedRide = rides.find((r) => r.id === selectedRideId) ?? null;
  const selectedCar = selectedRide ? (carsQuery.data ?? []).find((c) => c.id === selectedRide.car_id) ?? null : null;
  const selectedLocation = selectedRide
    ? carLocationsQuery.data?.find((l) => l.car_id === selectedRide.car_id)?.location_name ?? null
    : null;

  const weekGridCars: WeekGridCar[] = useMemo(
    () =>
      (carsQuery.data ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        group: c.type,
        locationBadge: carLocationsQuery.data?.find((l) => l.car_id === c.id)?.location_name ?? undefined,
      })),
    [carsQuery.data, carLocationsQuery.data],
  );
  // Not memoized: `activeDayRides` is a freshly derived array each render (it comes from
  // `.find(...)?.items`), so a `useMemo` here would never skip recomputation anyway — the
  // mapping itself is cheap (one day's rides, a handful of rows).
  const weekGridRides: WeekGridRide[] = activeDayRides
    .filter((r) => r.car_id && r.starts_at && r.ends_at)
    .map((r) => ({
      id: r.id as string,
      carId: r.car_id as string,
      startMinutes: minutesSinceMidnight(r.starts_at as string),
      endMinutes: minutesSinceMidnight(r.ends_at as string),
      label: r.destination_name ?? "",
    }));

  function goTo(nextDept: string, nextWeek: string | undefined) {
    navigate(nextWeek ? `/siddur/${nextDept}/${nextWeek}` : "/siddur");
  }

  const dayCounts = dayGroups.map((g) => ({ rides: g.items.length, unmet: 0 }));

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24">
      <PageHeader
        title={t("screen.siddur.title")}
        subtitle={weekStart ? formatWeekRangeLabel(weekStart) : undefined}
        actions={
          (myDepartmentsQuery.data?.length ?? 0) > 1 || (departmentsQuery.data?.length ?? 0) > 1 ? (
            <Select
              value={departmentId}
              onValueChange={(next) => goTo(next, undefined)}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder={he.siddur.departmentSwitcher} />
              </SelectTrigger>
              <SelectContent>
                {(departmentsQuery.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />

      {!isMyDepartment ? <p className="text-xs text-muted-foreground">{he.siddur.otherDeptNote}</p> : null}

      {weeks.length > 1 ? (
        <div className="flex items-center gap-2 overflow-x-auto">
          {weeks.map((w) => (
            <button
              key={w.week_start}
              type="button"
              onClick={() => goTo(departmentId as string, w.week_start)}
              className={
                "shrink-0 rounded-md border px-2 py-1 text-xs " +
                (w.week_start === weekStart ? "border-primary bg-primary/10" : "border-input")
              }
            >
              <span dir="ltr">{formatWeekRangeLabel(w.week_start)}</span> · {he.phase[w.phase]}
            </button>
          ))}
        </div>
      ) : null}

      {!resolvedWeek ? (
        <EmptyState icon={CalendarDays} message={he.requestsList.empty} />
      ) : resolvedWeek.phase === "open" || resolvedWeek.phase === "solving" ? (
        <EmptyState
          icon={Inbox}
          message={tv("siddur.notPublishedYet", { weekLabel: formatWeekRangeLabel(resolvedWeek.week_start) })}
          action={
            <a href="/requests" className="text-sm font-medium text-primary underline">
              {he.siddur.notPublishedAction}
            </a>
          }
        />
      ) : (
        <>
          <DestinationCombobox
            destinations={(destinationsQuery.data ?? []).map((d) => ({
              id: d.id,
              name: d.name,
              aliases: d.aliases,
              zone: d.zone,
            }))}
            value={destFilter}
            mode="filter"
            onChange={setDestFilter}
          />

          <div className="lg:hidden">
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <div className="mt-3 space-y-2">
              {filterName && activeDayRides.length === 0 ? (
                <EmptyState
                  icon={CalendarDays}
                  message={tv("siddur.filterEmpty", { destination: filterName })}
                />
              ) : activeDayRides.length === 0 ? (
                <EmptyState icon={CalendarDays} message={he.siddur.noRides} />
              ) : (
                activeDayRides.map((r) => {
                  const data: RideCardData = {
                    id: r.id as string,
                    startsAt: r.starts_at as string,
                    endsAt: r.ends_at,
                    originName: r.origin_name ?? "",
                    destinationName: r.destination_name ?? "",
                    driverName: r.driver_name,
                    isChauffeur: !!r.is_chauffeur,
                    carName: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.name ?? null,
                    carType: (carsQuery.data ?? []).find((c) => c.id === r.car_id)?.type,
                  };
                  return <RideCard key={r.id} ride={data} onClick={() => setSelectedRideId(r.id as string)} />;
                })
              )}
            </div>
          </div>

          <div className="hidden lg:block">
            <WeekStrip weekStart={weekStart as string} counts={dayCounts} selected={activeDay ?? ""} onSelect={setSelectedDay} />
            <div className="mt-3">
              <WeekGrid
                cars={weekGridCars}
                rides={weekGridRides}
                readOnly
                onRideClick={setSelectedRideId}
              />
            </div>
          </div>
        </>
      )}

      <RideDetailSheet
        ride={selectedRide}
        car={selectedCar}
        locationBadge={selectedLocation}
        onOpenChange={(open) => !open && setSelectedRideId(null)}
        onAskToJoin={() => selectedRide && navigate(`/requests/new?ride=${selectedRide.id}`)}
        showAskToJoin={!!selectedRide && isMyDepartment && selectedRide.driver_id !== profileId}
      />

      {isMyDepartment ? (
        <a
          href="/requests/new"
          className="fixed bottom-20 end-4 z-30 flex size-14 items-center justify-center rounded-full bg-primary text-2xl text-primary-foreground shadow-lg md:bottom-6"
          aria-label={t("action.newRequest")}
        >
          +
        </a>
      ) : null}
    </div>
  );
}
