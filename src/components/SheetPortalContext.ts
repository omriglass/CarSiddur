import { createContext } from "react";

/**
 * DOM node to portal a field's own Radix popover into, when one is available (set by an
 * ancestor modal `Sheet`/`Dialog` via `SheetPortalContext.Provider` — in practice always
 * through `PortalSheetContent`/`PortalDialogContent`, never a hand-rolled provider; any Sheet
 * or Dialog that hosts one of the fields below should use one of those wrappers instead of the
 * raw `SheetContent`/`DialogContent`).
 *
 * Radix's `Dialog`/`Sheet` locks background touch-scroll (`react-remove-scroll`) by only
 * allowing scroll within its own content subtree. A popover that portals to `document.body`
 * by default (the shared `components/ui/popover.tsx`'s `PopoverContent`, and any field that
 * rolls its own Radix popover the same way) becomes a DOM *sibling* of the Sheet's own portal,
 * not a descendant — so the scroll lock can't tell the popover's own scrollable content is
 * meant to be scrollable and blocks its touchmove entirely. Portaling into the Sheet's content
 * node instead makes it a real descendant, which both fixes the touch-scroll and keeps
 * positioning correct (Radix's Popper math accounts for a transformed ancestor).
 * Defaults to `null` (portal to `document.body`, unaffected) outside any such ancestor.
 *
 * Shared by every field that opens its own Radix popover while it may be rendered inside a
 * modal `Sheet`/`Dialog` (`TimeField15`, `DestinationCombobox`, `CompanionPicker`) —
 * generalized from the original `TimeField15`-only `TimeFieldPortalContext` once
 * `DestinationCombobox` and `CompanionPicker` needed the identical fix for their own popovers
 * (UX_FLOWS.md component inventory).
 */
export const SheetPortalContext = createContext<HTMLElement | null>(null);
