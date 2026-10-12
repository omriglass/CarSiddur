import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import type { WeekGridAmbientBlock } from "@/components/WeekGrid";
import { addDaysToKey } from "../requests/myWeek/dayColumns";
import { eventsToAmbientBlocks } from "./ambientBlocks";
import { CalendarAuthError } from "./googleSource";
import type { CalendarEvent } from "./types";
import { useCalendar } from "./useCalendar";

const NO_BLOCKS: WeekGridAmbientBlock[] = [];

/**
 * The faint calendar blocks for one week of the "my rides" grid. Empty — and no query runs — while no source is
 * connected or `weekStart` is undefined (the caller passes undefined while the experimental feature is off). The events
 * are read in the browser by the source; they are cached by TanStack Query in memory only (the app's query client does
 * not persist). Display preferences are applied on top of the cached events, so toggling a field redraws at once. An
 * expired token drops the source, so the screen offers "show my calendar" again.
 */
export function useCalendarAmbientBlocks(weekStart: string | undefined): readonly WeekGridAmbientBlock[] {
  const { source, setSource, selectedCalendarIds, displayPrefs } = useCalendar();
  const enabled = !!source && !!weekStart && selectedCalendarIds.length > 0;
  const query = useQuery({
    queryKey: ["calendar", "events", weekStart, selectedCalendarIds],
    queryFn: (): Promise<CalendarEvent[]> => {
      // A generous window around the week (Jerusalem days); `eventsToAmbientBlocks` keeps only the week's own days.
      const from = `${addDaysToKey(weekStart as string, -1)}T00:00:00Z`;
      const to = `${addDaysToKey(weekStart as string, 8)}T00:00:00Z`;
      return (source as NonNullable<typeof source>).listEvents(selectedCalendarIds, from, to);
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: (failures, error) => !(error instanceof CalendarAuthError) && failures < 2,
  });
  const authExpired = query.error instanceof CalendarAuthError;
  useEffect(() => {
    if (authExpired) setSource(null);
  }, [authExpired, setSource]);
  const events = query.data;
  const blocks = useMemo(() => (events && weekStart ? eventsToAmbientBlocks(events, weekStart, displayPrefs) : NO_BLOCKS), [events, weekStart, displayPrefs]);
  return enabled ? blocks : NO_BLOCKS;
}
