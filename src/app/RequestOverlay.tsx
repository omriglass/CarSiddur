import type { ReactNode } from "react";

import { PortalSheetContent } from "@/components/PortalSheetContent";
import { CENTERED_ON_DESKTOP } from "@/components/sheetLayout";
import { Sheet, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { useCloseRequestOverlay } from "./overlayState";

interface RequestOverlayProps {
  title: string;
  /** Right next to the title, e.g. the week label. */
  subtitle?: ReactNode;
  children: ReactNode;
}

/**
 * The sentence-layout request form's frame: a centred card from `md` up, a bottom sheet on phones,
 * over the dimmed page the member came from (UX_FLOWS §3.4a). Closing (X, Esc, backdrop) returns
 * to that page; `RequestForm`'s sticky footer sticks to the bottom of this card
 * (`SheetPortalContext`). The pickers (`FieldSheet`) are nested dialogs on top.
 */
export function RequestOverlay({ title, subtitle, children }: RequestOverlayProps) {
  const close = useCloseRequestOverlay();
  return (
    <Sheet open onOpenChange={(open) => { if (!open) close(); }}>
      <PortalSheetContent
        side="bottom"
        data-testid="request-overlay"
        className={`max-h-[92dvh] overflow-y-auto overscroll-contain rounded-t-2xl p-0 md:max-h-[85dvh] ${CENTERED_ON_DESKTOP}`}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetHeader className="flex-row items-baseline gap-2 space-y-0 px-4 pb-0 pe-12 pt-4 text-start">
          <SheetTitle className="text-base">{title}</SheetTitle>
          {subtitle ? <span className="text-sm text-muted-foreground">{subtitle}</span> : null}
          <SheetDescription className="sr-only">{title}</SheetDescription>
        </SheetHeader>
        {children}
      </PortalSheetContent>
    </Sheet>
  );
}
