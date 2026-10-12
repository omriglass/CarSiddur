import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { WeekGridAmbientBlock } from "@/components/WeekGrid";
import { addDaysToKey } from "../requests/myWeek/dayColumns";
import { eventsToAmbientBlocks } from "./ambientBlocks";
import { CalendarAuthError } from "./googleSource";
import { useCalendar } from "./useCalendar";

const NO_BLOCKS: WeekGridAmbientBlock[] = [];

/**
 * The faint calendar blocks for one week of the "my rides" grid. Empty — and no query runs — while no source is
 * connected or `weekStart` is undefined (the caller passes undefined while the experimental feature is off). The events
 * are read in the browser by the source; they are cached by TanStack Query in memory only (the app's query client does
 * not persist). An expired token drops the source, so the screen offers "show my calendar" again.
 */
export function useCalendarAmbientBlocks(weekStart: string | undefined): readonly WeekGridAmbientBlock[] {
  const { source, setSource, selectedCalendarIds } = useCalendar();
  const enabled = !!source && !!weekStart && selectedCalendarIds.length > 0;
  const query = useQuery({
    queryKey: ["calendar", "events", weekStart, selectedCalendarIds],
    queryFn: async () => {
      // A generous window around the week (Jerusalem days); `eventsToAmbientBlocks` keeps only the week's own days.
      const from = `${addDaysToKey(weekStart as string, -1)}T00:00:00Z`;
      const to = `${addDaysToKey(weekStart as string, 8)}T00:00:00Z`;
      const events = await (source as NonNullable<typeof source>).listEvents(selectedCalendarIds, from, to);
      return eventsToAmbientBlocks(events, weekStart as string);
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: (failures, error) => !(error instanceof CalendarAuthError) && failures < 2,
  });
  const authExpired = query.error instanceof CalendarAuthError;
  useEffect(() => {
    if (authExpired) setSource(null);
  }, [authExpired, setSource]);
  return enabled ? (query.data ?? NO_BLOCKS) : NO_BLOCKS;
}
