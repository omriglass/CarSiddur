// UX_FLOWS §3.4a: the bottom sheet every sentence chip opens. `PortalSheetContent` makes the
// popovers of the fields inside (TimeField15, CompanionPicker) scroll on touch (UX_FLOWS §18
// "Item 4"); focus returns to the chip on close (Radix).
import type { ReactNode } from "react";

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
}

export function FieldSheet({ open, onOpenChange, title, children, hideFooter, testId }: FieldSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <PortalSheetContent
        side="bottom"
        className={`max-h-[85dvh] overflow-y-auto overscroll-contain rounded-t-xl p-4 pt-3 ${CENTERED_ON_DESKTOP}`}
        data-testid={testId}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="space-y-0 text-start">
          <SheetTitle className="text-base">{title}</SheetTitle>
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 pb-1 pt-3">{children}</div>
        {hideFooter ? null : (
          <div className="sticky -bottom-4 -mx-4 -mb-4 border-t bg-background p-3">
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              {he.requestSentence.sheetDone}
            </Button>
          </div>
        )}
      </PortalSheetContent>
    </Sheet>
  );
}
