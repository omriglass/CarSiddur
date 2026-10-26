import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { CalendarAuthError } from "./googleSource";
import { eventsByDay, type MonthEventBlock } from "./monthBlocks";
import type { CalendarEvent } from "./types";
import { useCalendar } from "./useCalendar";

const NONE = new Map<string, MonthEventBlock[]>();

/**
 * REQ §13.154 (f): the member's calendar events per day for the planning month (`from`..`to`, `yyyy-MM-dd`). Empty — and
 * no query runs — while no source is connected (the experimental feature is off) or nothing is picked. Memory-only cache.
 */
export function useCalendarMonthEvents(from: string | undefined, to: string | undefined): Map<string, MonthEventBlock[]> {
  const { source, setSource, selectedCalendarIds } = useCalendar();
  const enabled = !!source && !!from && !!to && selectedCalendarIds.length > 0;
  const query = useQuery({
    queryKey: ["calendar", "month", from, to, selectedCalendarIds],
    queryFn: (): Promise<CalendarEvent[]> =>
      (source as NonNullable<typeof source>).listEvents(selectedCalendarIds, `${from as string}T00:00:00Z`, `${to as string}T23:59:59Z`),
    enabled,
    staleTime: 5 * 60_000,
    retry: (failures, error) => !(error instanceof CalendarAuthError) && failures < 2,
  });
  const authExpired = query.error instanceof CalendarAuthError;
  useEffect(() => {
    if (authExpired) setSource(null);
  }, [authExpired, setSource]);
  const events = query.data;
  const byDay = useMemo(() => (events ? eventsByDay(events) : NONE), [events]);
  return enabled ? byDay : NONE;
}
