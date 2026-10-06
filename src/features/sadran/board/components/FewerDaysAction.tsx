// REQ §13.101 (j, QF5): on an unmet multi-day request the Sadran may propose fewer consecutive
// days on one car ("2 days instead of 3"). Picks the first/last day and a car (default: a car free
// for the span), then hands a `shift` prefill with `series_span` to the board's proposal flow
// (טיוטה / הכן הצעה via DraftChoiceDialog).
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { he, tv } from "@/i18n/he";
import { formatDayDate } from "@/lib/dayLabels";

import { useSeriesLegsQuery } from "../../hooks";
import { activeSeriesLegs, buildSeriesSpan, seriesHead, seriesSpanPrefill } from "../seriesSpan";

import type { ComposerPrefill } from "../draftInput";
import type { WeekRequestRow } from "../../api";

export interface FewerDaysSupport {
  cars: readonly { id: string; name: string }[];
  /** Is the car free for the whole span (the board's own rides/maintenance; the server re-checks)? */
  isCarFree: (carId: string, startsAt: string, endsAt: string, hasLuggage: boolean, originId?: string | null) => boolean;
  /** The board's proposal entry point (draft / prepare choice). */
  onPropose: (prefill: ComposerPrefill) => void;
  /** Requests loaded on this board - the proposal's request must be one of them. */
  requestIds: ReadonlySet<string>;
}

export interface FewerDaysActionProps {
  request: Pick<WeekRequestRow, "id" | "series_id" | "has_luggage" | "origin_id" | "requester_full_name">;
  support: FewerDaysSupport;
}

export function FewerDaysAction({ request, support }: FewerDaysActionProps) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [carChoice, setCarChoice] = useState<string | null>(null);
  const legsQuery = useSeriesLegsQuery(request.series_id, open);
  if (!request.series_id) return null;

  const legs = activeSeriesLegs(legsQuery.data ?? []);
  const fromIndex = from ?? 0;
  // Default last day: one day short of the whole series, but never before the chosen first day.
  const toIndex = to ?? Math.max(fromIndex, fromIndex === 0 ? legs.length - 2 : legs.length - 1);
  const span = buildSeriesSpan(legs, fromIndex, toIndex);
  const freeCar = span ? support.cars.find((car) => support.isCarFree(car.id, span.depart_at, span.return_at, !!request.has_luggage, request.origin_id)) : undefined;
  const carId = carChoice ?? freeCar?.id ?? null;
  const head = seriesHead(legs);
  // The proposal belongs to a request this board has loaded: the head when it is in this week, else this leg.
  const proposalRequestId = head && support.requestIds.has(head.id) ? head.id : request.id;

  function reset(next: boolean) {
    setOpen(next);
    if (!next) { setFrom(null); setTo(null); setCarChoice(null); }
  }
  function confirm() {
    if (!span || !carId) return;
    support.onPropose(seriesSpanPrefill(proposalRequestId, carId, span));
    reset(false);
  }
  const dayOptions = legs.map((leg, index) => ({ index, label: formatDayDate(leg.departAt) }));

  return (
    <>
      <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => reset(true)} data-testid="fewer-days">
        {he.fewerDays.action}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={reset}
        title={tv("fewerDays.title", { name: request.requester_full_name ?? "" })}
        description={he.fewerDays.description}
        confirmLabel={he.fewerDays.confirm}
        confirmDisabled={!span || !carId}
        onConfirm={confirm}
      >
        <div className="space-y-3 text-sm" data-testid="fewer-days-dialog">
          {legsQuery.isLoading ? <p className="text-muted-foreground">{he.common.loading}</p> : null}
          {legs.length > 1 ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{he.fewerDays.fromDay}</span>
                  <Select value={String(fromIndex)} onValueChange={(value) => setFrom(Number(value))}>
                    <SelectTrigger className="min-h-11" aria-label={he.fewerDays.fromDay} data-testid="fewer-days-from"><SelectValue /></SelectTrigger>
                    <SelectContent>{dayOptions.map((day) => <SelectItem key={day.index} value={String(day.index)}>{day.label}</SelectItem>)}</SelectContent>
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">{he.fewerDays.toDay}</span>
                  <Select value={String(toIndex)} onValueChange={(value) => setTo(Number(value))}>
                    <SelectTrigger className="min-h-11" aria-label={he.fewerDays.toDay} data-testid="fewer-days-to"><SelectValue /></SelectTrigger>
                    <SelectContent>{dayOptions.map((day) => <SelectItem key={day.index} value={String(day.index)}>{day.label}</SelectItem>)}</SelectContent>
                  </Select>
                </label>
              </div>
              {!span ? <p className="text-destructive" data-testid="fewer-days-invalid">{he.fewerDays.invalidSpan}</p> : null}
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">{he.fewerDays.car}</span>
                <Select value={carId ?? ""} onValueChange={setCarChoice}>
                  <SelectTrigger className="min-h-11" aria-label={he.fewerDays.car} data-testid="fewer-days-car"><SelectValue placeholder={he.fewerDays.noFreeCar} /></SelectTrigger>
                  <SelectContent>
                    {support.cars.map((car) => (
                      <SelectItem key={car.id} value={car.id}>
                        {span && support.isCarFree(car.id, span.depart_at, span.return_at, !!request.has_luggage, request.origin_id) ? car.name : `${car.name} · ${he.fewerDays.notFree}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {span && !carId ? <p className="text-destructive">{he.fewerDays.noFreeCar}</p> : null}
            </>
          ) : legsQuery.isSuccess ? <p className="text-muted-foreground">{he.fewerDays.invalidSpan}</p> : null}
        </div>
      </ConfirmDialog>
    </>
  );
}
