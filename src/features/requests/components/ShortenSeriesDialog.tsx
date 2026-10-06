import { useState } from "react";
import { toast } from "sonner";

import { FormDialog } from "@/components/FormDialog";
import { TimeField15 } from "@/components/TimeField15";
import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";
import { cn } from "@/lib/utils";

import { useShortenSeriesMutation } from "../hooks";
import { buildShortenArgs, seriesDayOptions } from "../shorten";
import type { DisplayRow } from "../myRequestsRows";

interface Props {
  row: DisplayRow | null;
  onOpenChange: (open: boolean) => void;
}

function DayChips({ days, value, onChange, label }: { days: string[]; value: string; onChange: (day: string) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {days.map((day) => (
        <Button
          key={day}
          type="button"
          role="radio"
          aria-checked={day === value}
          variant={day === value ? "default" : "outline"}
          className={cn("min-h-11")}
          onClick={() => onChange(day)}
        >
          <span dir="ltr">{formatDayDate(`${day}T12:00:00Z`)}</span>
        </Button>
      ))}
    </div>
  );
}

/** REQ §13.103 c / R3F2: pick the new first day + departure and the new last day + return. */
export function ShortenSeriesDialog({ row, onOpenChange }: Props) {
  const legs = row?.seriesLegs ?? [];
  const days = seriesDayOptions(legs);
  const [firstDay, setFirstDay] = useState<string | null>(null);
  const [lastDay, setLastDay] = useState<string | null>(null);
  const [departTime, setDepartTime] = useState<string | null>(null);
  const [returnTime, setReturnTime] = useState<string | null>(null);
  const mutation = useShortenSeriesMutation();

  const first = firstDay ?? days[0]?.day ?? "";
  const last = lastDay ?? days[days.length - 1]?.day ?? "";
  const depart = departTime ?? days[0]?.departTime ?? "08:00";
  const ret = returnTime ?? days[days.length - 1]?.returnTime ?? "18:00";
  const built = days.length ? buildShortenArgs({ days, firstDay: first, departTime: depart, lastDay: last, returnTime: ret }) : { error: "invalidRange" as const };
  const error = "error" in built ? built.error : null;

  function close(open: boolean) {
    if (!open) { setFirstDay(null); setLastDay(null); setDepartTime(null); setReturnTime(null); }
    onOpenChange(open);
  }

  return (
    <FormDialog
      open={!!row}
      onOpenChange={close}
      title={he.request.shortenSeriesTitle}
      description={he.request.shortenSeriesHelp}
      submitLabel={he.request.shortenSubmit}
      loading={mutation.isPending}
      submitDisabled={!!error}
      onSubmit={() => {
        if (!row || "error" in built) return;
        mutation.mutate(
          { requestId: row.id, departAt: built.departAt, returnAt: built.returnAt },
          { onSuccess: () => { toast.success(he.request.shortenDone); close(false); } },
        );
      }}
    >
      <div className="space-y-4" data-testid="shorten-series-form">
        <div className="space-y-2">
          <p className="text-sm font-medium">{he.request.shortenFirstDay}</p>
          <DayChips days={days.map((d) => d.day)} value={first} onChange={setFirstDay} label={he.request.shortenFirstDay} />
          <TimeField15 value={depart} onChange={setDepartTime} aria-label={he.request.shortenDepartTime} />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{he.request.shortenLastDay}</p>
          <DayChips days={days.map((d) => d.day)} value={last} onChange={setLastDay} label={he.request.shortenLastDay} />
          <TimeField15 value={ret} onChange={setReturnTime} aria-label={he.request.shortenReturnTime} />
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error === "invalidRange" ? he.request.shortenInvalidRange : he.request.shortenUnchanged}</p> : null}
      </div>
    </FormDialog>
  );
}
