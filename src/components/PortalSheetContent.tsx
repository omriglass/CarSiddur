import * as React from "react";

import { SheetPortalContext } from "@/components/SheetPortalContext";
import { SheetContent, type SheetContentProps } from "@/components/ui/sheet";

/**
 * `SheetContent` wrapper that captures its own DOM node and provides it via
 * `SheetPortalContext`, so any `TimeField15`/`DestinationCombobox`/
 * `CompanionPicker` rendered inside — directly or through a child form/
 * component — portals its own Radix popover as a descendant of the sheet's
 * content instead of a `document.body` sibling, fixing touch-scroll under
 * the sheet's modal scroll lock (see `SheetPortalContext`'s docstring for
 * why). Use this instead of the raw `SheetContent` for any Sheet that hosts
 * one of those fields (UX_FLOWS.md component inventory).
 */
export const PortalSheetContent = React.forwardRef<HTMLDivElement, SheetContentProps>(
  function PortalSheetContent({ children, ...props }, forwardedRef) {
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
      <SheetContent ref={setRef} {...props}>
        <SheetPortalContext.Provider value={node}>{children}</SheetPortalContext.Provider>
      </SheetContent>
    );
  },
);
