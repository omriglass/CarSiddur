// REQ §13.175 (b): the merged ride reaches the guest at another time than the guest asked - the Sadran picks which side
// gives: take the guest at the ride's time, or stretch the host's ride to the guest's time. Never decided silently.
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { MergeWaitChoice } from "../mergeQuestions";

export function MergeWaitDialog({ choice, guest, host, place, onAnswer }: {
  choice: MergeWaitChoice;
  guest: string;
  host: string;
  /** The guest's place on that leg (the pickup place on the way back). */
  place: string;
  onAnswer: (answer: "extend" | "keep" | null) => void;
}) {
  const eta = formatTime(new Date(choice.eta));
  const wanted = formatTime(new Date(choice.wanted));
  const stretchTo = choice.endsAt ?? choice.startsAt;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer(null); }}>
      <DialogContent data-testid="merge-wait-dialog" className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tv("mergedRide.waitTitle", { name: guest, wanted })}</DialogTitle>
          <DialogDescription>
            {tv(choice.side === "return" ? "mergedRide.waitBodyReturn" : "mergedRide.waitBodyOut", { host, place, eta, name: guest })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {stretchTo ? (
            <Button className="min-h-11 whitespace-normal" onClick={() => onAnswer("extend")} data-testid="merge-wait-extend">
              {tv(choice.side === "return" ? "mergedRide.waitExtendReturn" : "mergedRide.waitExtendOut", { host, time: formatTime(new Date(stretchTo)), wanted })}
            </Button>
          ) : null}
          <Button variant="secondary" className="min-h-11 whitespace-normal" onClick={() => onAnswer("keep")} data-testid="merge-wait-keep">
            {tv("mergedRide.waitKeep", { name: guest, eta })}
          </Button>
          <Button variant="outline" className="min-h-11" onClick={() => onAnswer(null)}>{he.common.cancel}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
