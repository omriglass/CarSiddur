import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { isWholeDaySpan } from "@/lib/wholeDay";
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
  const wholeDay = isWholeDaySpan(departAt, returnAt);
  // The last calendar day a whole-day span covers (a next-midnight end belongs to the day before).
  const lastDay = wholeDay && returnAt ? dateKey(Date.parse(returnAt) - 60_000) : null;
  const crossesDate = departAt && returnAt && dateKey(departAt) !== dateKey(returnAt);
  return <div className="space-y-1 text-sm" data-trip-summary>
    {name || destination ? <p className="font-semibold">{[name, destination].filter(Boolean).join(" · ")}</p> : null}
    <p className="text-muted-foreground">
      {anchor ? <>
        {dateLabel(anchor)} · {wholeDay ? <>
          {he.flex.anyTime}{lastDay && lastDay !== dateKey(departAt!) ? <> – {dateLabel(lastDay)}</> : null}
        </> : departAt && returnAt ? <>
          {/* R9B5: an LTR isolate, otherwise an RTL page shows the range reversed ("23:15–20:00"). */}
          <span dir="ltr">{formatTime(new Date(departAt))}–{crossesDate ? <>{dateLabel(returnAt)} </> : null}{formatTime(new Date(returnAt))}</span>
        </> : <>{departAt ? he.field.depart : he.field.return} <bdi>{formatTime(new Date(anchor))}</bdi></>}
      </> : null}
      {purpose ? <>{anchor ? " · " : ""}{purpose}</> : null}
    </p>
  </div>;
}
