import type { ReactNode } from "react";

import { PortalSheetContent } from "@/components/PortalSheetContent";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface MyWeekItemSheetProps {
  open: boolean;
  title: string;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** The bottom sheet a tapped request / suggestion block opens on `/my?view=week` (same shape as `RideDetailSheet`). */
export function MyWeekItemSheet({ open, title, onOpenChange, children }: MyWeekItemSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <PortalSheetContent side="bottom" className="max-h-[85dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="mt-3 space-y-3">{children}</div>
      </PortalSheetContent>
    </Sheet>
  );
}
