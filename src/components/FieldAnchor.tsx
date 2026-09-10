import type { ReactNode } from "react";

interface FieldAnchorProps {
  /** react-hook-form field name this wraps — matched by `useScrollToFirstError`'s `[data-field]` lookup. */
  name: string;
  children: ReactNode;
  className?: string;
}

/**
 * Marks a field that has no natural single DOM root to carry `data-field` itself (a bare
 * `Controller` render with no `FormItem`/wrapper `div`) so `useScrollToFirstError` can find and
 * scroll to it. `scroll-mt-24` keeps a fixed header/submit bar from covering the anchor once
 * scrolled into view; `tabIndex={-1}` + `outline-none` let it receive focus itself as a last
 * resort (see `focusInvalidElement`) without adding a visible focus ring on a plain wrapper.
 */
export function FieldAnchor({ name, children, className }: FieldAnchorProps) {
  return (
    <div data-field={name} tabIndex={-1} className={className ? `scroll-mt-24 outline-none ${className}` : "scroll-mt-24 outline-none"}>
      {children}
    </div>
  );
}
