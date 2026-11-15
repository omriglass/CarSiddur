// MD1 (owner 2026-11-14, REQ item 232): a one-day ride turned multi-day, and its car is taken on a later day. The
// question names what blocks it; the answers return earlier (the latest return that fits), replace the member's own
// ride (two buttons when that ride ends after the new return: keep which end), or cancel the change.
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { weekdayLabel } from "@/lib/dayLabels";
import { formatTime } from "@/lib/time";
import { he, tv } from "@/i18n/he";

import { seriesCarTakenText, type SeriesCarTakenAnswer, type SeriesCarTakenQuestion } from "../seriesCarTaken";

export type { SeriesCarTakenAnswer, SeriesCarTakenQuestion };

export function SeriesCarTakenDialog({ question, onAnswer, onCancel }: {
  question: SeriesCarTakenQuestion | null;
  onAnswer: (answer: SeriesCarTakenAnswer) => void;
  onCancel: () => void;
}) {
  const blocker = question?.blocker;
  const ownRideId = blocker?.kind === "own_ride" ? blocker.ride_id : undefined;
  const laterEnd = !!question && !!blocker && new Date(blocker.ends_at).getTime() > new Date(question.requestedReturn).getTime();
  return (
    <ConfirmDialog
      open={!!question}
      onOpenChange={(open) => { if (!open) onCancel(); }}
      title={question ? seriesCarTakenText(question) : ""}
      cancelLabel={he.request.carTakenCancel}
      hideConfirm
      onConfirm={onCancel}
    >
      {question && blocker ? (
        <div className="flex flex-col gap-2" data-testid="series-car-taken">
          {ownRideId && laterEnd ? (
            <>
              <Button onClick={() => onAnswer({ kind: "replace", rideId: ownRideId, keepLaterEnd: true })} data-testid="series-replace-later">
                {tv("request.carTakenReplaceReturn", { time: formatTime(new Date(blocker.ends_at)) })}
              </Button>
              <Button variant="outline" onClick={() => onAnswer({ kind: "replace", rideId: ownRideId, keepLaterEnd: false })} data-testid="series-replace-new">
                {tv("request.carTakenReplaceReturn", { time: formatTime(new Date(question.requestedReturn)) })}
              </Button>
            </>
          ) : ownRideId ? (
            <Button onClick={() => onAnswer({ kind: "replace", rideId: ownRideId, keepLaterEnd: false })} data-testid="series-replace">
              {tv("request.carTakenReplace", { weekday: `${weekdayLabel(blocker.starts_at, "short")}${he.days.geresh}` })}
            </Button>
          ) : null}
          {question.latestReturn ? (
            <Button variant={ownRideId ? "outline" : "default"} onClick={() => onAnswer({ kind: "returnEarlier" })} data-testid="series-return-earlier">
              {tv("request.carTakenReturnEarlier", { time: formatTime(new Date(question.latestReturn)) })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
