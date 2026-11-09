// UX_FLOWS §3.4a: the bottom sheet every sentence chip opens. `PortalSheetContent` makes the
// popovers of the fields inside (TimeField15, CompanionPicker) scroll on touch (UX_FLOWS §18
// "Item 4"); focus returns to the chip on close (Radix). `scroll-pb-20`: a focused field is scrolled above the sticky
// "אישור" footer, never under it (owner 2026-11-09).
import { useState, type FocusEvent, type ReactNode } from "react";

import { PortalSheetContent } from "@/components/PortalSheetContent";
import { CENTERED_ON_DESKTOP } from "@/components/sheetLayout";
import { Button } from "@/components/ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { he } from "@/i18n/he";

interface FieldSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** Hide the "אישור" footer for sheets that close themselves on pick (places). */
  hideFooter?: boolean;
  testId?: string;
  /** "אישור" — when set, it differs from dismissing (×, Escape, outside): the guided new request moves on (owner 2026-10-11). */
  onDone?: () => void;
  /**
   * Owner 2026-11-09 ("מי נוסע?"): while a text field inside has focus the "אישור" footer steps aside and the field
   * scrolls to the top of the sheet, so the keyboard, the footer and the field's own "הוספה" never cover each other.
   */
  typingFocus?: boolean;
}

function isTextField(target: EventTarget | null): target is HTMLInputElement | HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement
    || (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit", "range"].includes(target.type));
}

export function FieldSheet({ open, onOpenChange, title, children, hideFooter, testId, onDone, typingFocus }: FieldSheetProps) {
  const [typing, setTyping] = useState(false);
  if (!open && typing) setTyping(false);
  function onFocusIn(event: FocusEvent<HTMLDivElement>) {
    if (!typingFocus || !isTextField(event.target)) return;
    setTyping(true);
    const field = event.target;
    // After the on-screen keyboard has opened (it resizes the viewport).
    window.setTimeout(() => field.scrollIntoView({ block: "start", behavior: "smooth" }), 300);
  }
  // Leaving the field, or its "הוספה" closing the panel: after the click (or submit) lands, read the real focus — never
  // on blur, which would move the layout between the press and the click.
  function recheck() {
    if (typingFocus) window.setTimeout(() => setTyping(isTextField(document.activeElement)), 0);
  }
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <PortalSheetContent
        side="bottom"
        className={`max-h-[85dvh] scroll-pb-20 overflow-y-auto overscroll-contain rounded-t-xl p-4 pt-3 ${CENTERED_ON_DESKTOP}`}
        data-testid={testId}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="space-y-0 text-start">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        <div className={typing ? "space-y-3 pb-[50dvh] pt-3" : "space-y-3 pb-1 pt-3"} onFocus={onFocusIn} onClick={recheck} onSubmitCapture={recheck}>{children}</div>
        {hideFooter || typing ? null : (
          <div className="sticky -bottom-4 -mx-4 -mb-4 border-t bg-background p-3">
            <Button type="button" className="w-full" onClick={() => (onDone ? onDone() : onOpenChange(false))}>
              {he.requestSentence.sheetDone}
            </Button>
          </div>
        )}
      </PortalSheetContent>
    </Sheet>
  );
}
