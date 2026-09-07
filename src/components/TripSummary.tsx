import { formatInTimeZone } from "date-fns-tz";
import { he } from "@/i18n/he";
import { TZ } from "@/lib/time";

interface TripSummaryProps {
  name?: string | null;
  destination?: string | null;
  purpose?: string | null;
  departAt: string | null;
  returnAt: string | null;
}

/** Identifies the requested trip independently of the changes listed below it. */
export function TripSummary({ name, destination, purpose, departAt, returnAt }: TripSummaryProps) {
  function dateLabel(instant: string) {
    const day = Number(formatInTimeZone(instant, TZ, "i")) % 7;
    return `${he.days.long[day]} ${formatInTimeZone(instant, TZ, "d/M/yyyy")}`;
  }
  const anchor = departAt ?? returnAt;
  const crossesDate = departAt && returnAt && formatInTimeZone(departAt, TZ, "yyyy-MM-dd") !== formatInTimeZone(returnAt, TZ, "yyyy-MM-dd");
  return <div className="space-y-1 text-sm" data-trip-summary>
    {name || destination ? <p className="font-semibold">{[name, destination].filter(Boolean).join(" · ")}</p> : null}
    <p className="text-muted-foreground">
      {anchor ? <>
        {dateLabel(anchor)} · {departAt && returnAt ? <>
          <bdi>{formatInTimeZone(departAt, TZ, "HH:mm")}</bdi>–{crossesDate ? <>{dateLabel(returnAt)} </> : null}<bdi>{formatInTimeZone(returnAt, TZ, "HH:mm")}</bdi>
        </> : <>{departAt ? he.field.depart : he.field.return} <bdi>{formatInTimeZone(anchor, TZ, "HH:mm")}</bdi></>}
      </> : null}
      {purpose ? <>{anchor ? " · " : ""}{purpose}</> : null}
    </p>
  </div>;
}
