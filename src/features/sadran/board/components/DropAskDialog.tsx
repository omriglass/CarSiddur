// REQ §13.161 (c): the words-first question before a merge / split / unplace drop on the board.
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { he, tv } from "@/i18n/he";
import { formatTime } from "@/lib/time";

import type { DropAnswer, DropAsk, SplitOutcome } from "../dropQuestions";

function Hours({ start, end }: { start: string; end: string }) {
  return <span dir="ltr" className="tabular-nums">{formatTime(new Date(start))}–{formatTime(new Date(end))}</span>;
}

function SplitBeforeAfter({ guest, host, outcome }: { guest: string; host: string; outcome: SplitOutcome }) {
  return (
    <div className="space-y-1 rounded-md border p-3 text-sm" data-testid="drop-ask-split-outcome">
      <p><span className="text-muted-foreground">{he.dropAsk.split.before}: </span><Hours start={outcome.beforeStart} end={outcome.beforeEnd} /></p>
      {outcome.afterStart && outcome.afterEnd ? (
        <p className="font-semibold text-maintenance" data-testid="drop-ask-split-after">
          {tv("dropAsk.split.hostBack", { host, time: `${formatTime(new Date(outcome.afterStart))}–${formatTime(new Date(outcome.afterEnd))}` })}
        </p>
      ) : (
        <p>{tv("dropAsk.split.hostSame", { host, time: `${formatTime(new Date(outcome.beforeStart))}–${formatTime(new Date(outcome.beforeEnd))}` })}</p>
      )}
      <p>{tv("dropAsk.split.guestBack", { guest })}</p>
    </div>
  );
}

export interface DropAskDialogProps {
  ask: DropAsk | null;
  onAnswer: (answer: DropAnswer) => void;
}

export function DropAskDialog({ ask, onAnswer }: DropAskDialogProps) {
  if (!ask) return null;
  const close = (open: boolean) => { if (!open) onAnswer("no"); };
  switch (ask.kind) {
    case "merge":
      return (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={he.dropAsk.merge.title}
          description={tv("dropAsk.merge.body", { guest: ask.guest, host: ask.host, car: ask.car })}
          confirmLabel={he.dropAsk.merge.yes}
          onConfirm={() => onAnswer("yes")}
          extraAction={<Button type="button" variant="secondary" className="w-full sm:w-auto" data-testid="drop-ask-move-only" onClick={() => onAnswer("alt")}>{he.dropAsk.merge.moveOnly}</Button>}
        >
          <ul className="space-y-1 text-sm text-muted-foreground" data-testid="drop-ask-merge-help">
            <li>{tv("dropAsk.merge.yesHelp", { guest: ask.guest, host: ask.host, car: ask.car })}</li>
            <li>{tv("dropAsk.merge.moveHelp", { car: ask.car })}</li>
          </ul>
        </ConfirmDialog>
      );
    case "split":
      return (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={he.dropAsk.split.title}
          description={tv("dropAsk.split.body", { guest: ask.guest, host: ask.host })}
          confirmLabel={he.dropAsk.split.confirm}
          onConfirm={() => onAnswer("yes")}
        >
          {ask.outcome ? <SplitBeforeAfter guest={ask.guest} host={ask.host} outcome={ask.outcome} /> : <p className="text-sm">{tv("dropAsk.split.guestBack", { guest: ask.guest })}</p>}
        </ConfirmDialog>
      );
    case "transfer":
      return (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={tv("dropAsk.transfer.title", { guest: ask.guest, host: ask.host })}
          description={tv("dropAsk.transfer.body", { guest: ask.guest, from: ask.from, host: ask.host, car: ask.car })}
          confirmLabel={tv("dropAsk.transfer.confirm", { host: ask.host })}
          onConfirm={() => onAnswer("yes")}
        >
          <p className="text-sm text-muted-foreground">{he.dropAsk.transfer.help}</p>
        </ConfirmDialog>
      );
    case "unplace":
      return (
        <ConfirmDialog
          open
          onOpenChange={close}
          title={tv("dropAsk.unplace.title", { name: ask.name })}
          description={he.dropAsk.unplace.body}
          confirmLabel={he.dropAsk.unplace.confirm}
          destructive
          onConfirm={() => onAnswer("yes")}
        />
      );
  }
}
