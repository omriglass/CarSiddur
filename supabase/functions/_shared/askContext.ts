/**
 * AI1 (REQ item 258 e): the model's context, built from `ask_context()` (read as the member) and the clock.
 * - Request ids never reach the model: each ride becomes RIDE_1, RIDE_2, … in start order; `refs` maps them back.
 * - The calendar is the next 14 days with weekday names, so the model looks dates up instead of computing them.
 * Pure (web-standard Intl only), shared by the edge function and Vitest.
 */
import type { AskContext, AskPerson, AskPlace, AskRide } from "./askPrompt.ts";

export interface AskContextRow {
  home: string;
  places: { name: string; aliases?: string[] | null }[];
  people: AskPerson[];
  rides: (Omit<AskRide, "ref" | "weekday"> & { request_id: string })[];
}

const TZ = "Asia/Jerusalem";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** The Asia/Jerusalem wall clock of an instant: date "YYYY-MM-DD" and time "HH:MM". */
export function jerusalemWallClock(at: Date): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** Calendar arithmetic on a date key (no time zone involved: the key is already the local day). */
function utcDay(date: string, plusDays = 0): Date {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + plusDays));
}
function addDays(date: string, days: number): string {
  return utcDay(date, days).toISOString().slice(0, 10);
}
function weekdayOf(date: string): string {
  return WEEKDAYS[utcDay(date).getUTCDay()] ?? "";
}

export function buildAskContext(row: AskContextRow, now: Date): { context: AskContext; refs: Record<string, string> } {
  const wall = jerusalemWallClock(now);
  const calendar = Array.from({ length: 14 }, (_, i) => {
    const date = addDays(wall.date, i);
    return { date, weekday: weekdayOf(date) };
  });
  const places: AskPlace[] = row.places.map((p) => (p.aliases?.length ? { name: p.name, aliases: p.aliases } : { name: p.name }));
  const refs: Record<string, string> = {};
  const myRides: AskRide[] = row.rides.map(({ request_id, ...ride }, i) => {
    const ref = `RIDE_${i + 1}`;
    refs[ref] = request_id;
    return { ref, ...ride, weekday: weekdayOf(ride.date) };
  });
  return {
    context: {
      now: `${wall.date}T${wall.time}`,
      weekday: weekdayOf(wall.date),
      calendar,
      home: row.home,
      places,
      people: row.people,
      my_rides: myRides,
    },
    refs,
  };
}
