import * as React from "react";

import { SheetPortalContext } from "@/components/SheetPortalContext";
import { DialogContent } from "@/components/ui/dialog";

/**
 * `DialogContent` wrapper that captures its own DOM node and provides it via
 * `SheetPortalContext` — the `Dialog` analogue of `PortalSheetContent`. A
 * modal `Dialog` locks background touch-scroll the same way a modal `Sheet`
 * does, so any `TimeField15`/`DestinationCombobox`/`CompanionPicker` hosted
 * inside needs the same fix (see `SheetPortalContext`'s docstring). Use this
 * instead of the raw `DialogContent` for any Dialog that hosts one of those
 * fields (UX_FLOWS.md component inventory).
 */
export const PortalDialogContent = React.forwardRef<
  React.ElementRef<typeof DialogContent>,
  React.ComponentPropsWithoutRef<typeof DialogContent>
>(function PortalDialogContent({ children, ...props }, forwardedRef) {
  const [node, setNode] = React.useState<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      setNode(el);
      if (typeof forwardedRef === "function") forwardedRef(el);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    },
    [forwardedRef],
  );
  return (
    <DialogContent ref={setRef} {...props}>
      <SheetPortalContext.Provider value={node}>{children}</SheetPortalContext.Provider>
    </DialogContent>
  );
});
