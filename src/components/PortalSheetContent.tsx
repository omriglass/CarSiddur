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
 *
 * A bottom sheet also stays above the on-screen keyboard (`src/lib/keyboardInset.ts`): it sits at
 * `--kb-inset` and fits the visible area, never taller than `maxDvh` (default 85dvh).
 */
export const PortalSheetContent = React.forwardRef<HTMLDivElement, SheetContentProps & { maxDvh?: number }>(
  function PortalSheetContent({ children, maxDvh = 85, style, ...props }, forwardedRef) {
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
      <SheetContent
        ref={setRef}
        style={props.side === "bottom"
          ? { bottom: "var(--kb-inset, 0px)", maxHeight: `min(${maxDvh}dvh, calc(var(--vv-height, 100dvh) - 0.5rem))`, ...style }
          : style}
        {...props}
      >
        <SheetPortalContext.Provider value={node}>{children}</SheetPortalContext.Provider>
      </SheetContent>
    );
  },
);
