// REQ item 258 (a), UX_FLOWS §3.4b: "+" for an opted-in member — the regular form or the chat. The service is asked
// before anyone types (owner 2026-11-20): not available → the chat row is greyed out with "לא זמין כרגע".
import { MessageSquareText, NotebookPen } from "lucide-react";

import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he } from "@/i18n/he";
import { cn } from "@/lib/utils";

import { useAskProbe } from "../hooks";

export function AskOrFormSheet({ open, onOpenChange, onForm, onAsk }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onForm: () => void;
  onAsk: () => void;
}) {
  const probe = useAskProbe(open);
  // While the check is still on its way the row shows normally; a tap waits for it below.
  const unavailable = probe.data ? !probe.data.available : probe.isError;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto" data-testid="ask-or-form-sheet">
        <SheetHeader>
          <SheetTitle>{he.ask.sheetTitle}</SheetTitle>
          <SheetDescription className="sr-only">{he.ask.hideHint}</SheetDescription>
        </SheetHeader>
        <div className="mt-3 space-y-2">
          <button type="button" onClick={onForm} data-testid="ask-choice-form"
            className="flex w-full items-center gap-3 rounded-lg border p-3 text-start hover:bg-muted">
            <NotebookPen className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span><span className="block font-medium">{he.ask.formTitle}</span><span className="block text-sm text-muted-foreground">{he.ask.formSub}</span></span>
          </button>
          <button type="button" data-testid="ask-choice-ask" disabled={unavailable} aria-disabled={unavailable}
            onClick={async () => {
              const result = probe.data ?? (await probe.refetch()).data;
              if (result?.available) onAsk();
            }}
            className={cn("flex w-full items-center gap-3 rounded-lg border p-3 text-start", unavailable ? "cursor-not-allowed opacity-50" : "hover:bg-muted")}>
            <MessageSquareText className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            <span>
              <span className="block font-medium">{he.ask.askTitle}</span>
              <span className="block text-sm text-muted-foreground" data-testid="ask-choice-ask-sub">{unavailable ? he.ask.unavailable : he.ask.askSub}</span>
            </span>
          </button>
          <p className="pt-1 text-xs text-muted-foreground">{he.ask.hideHint}</p>
        </div>
      </PortalSheetContent>
    </Sheet>
  );
}
