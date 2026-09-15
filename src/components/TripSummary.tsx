import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { dateKey, formatTime } from "@/lib/time";

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
    return formatDayDate(instant);
  }
  const anchor = departAt ?? returnAt;
  const crossesDate = departAt && returnAt && dateKey(departAt) !== dateKey(returnAt);
  return <div className="space-y-1 text-sm" data-trip-summary>
    {name || destination ? <p className="font-semibold">{[name, destination].filter(Boolean).join(" · ")}</p> : null}
    <p className="text-muted-foreground">
      {anchor ? <>
        {dateLabel(anchor)} · {departAt && returnAt ? <>
          <bdi>{formatTime(new Date(departAt))}</bdi>–{crossesDate ? <>{dateLabel(returnAt)} </> : null}<bdi>{formatTime(new Date(returnAt))}</bdi>
        </> : <>{departAt ? he.field.depart : he.field.return} <bdi>{formatTime(new Date(anchor))}</bdi></>}
      </> : null}
      {purpose ? <>{anchor ? " · " : ""}{purpose}</> : null}
    </p>
  </div>;
}
