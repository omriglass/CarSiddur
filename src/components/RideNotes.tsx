import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { RIDE_NOTES_ATTR, RIDE_NOTES_TRUNCATED_ATTR as TRUNCATED_ATTR } from "./rideNotesAttrs";

/**
 * A ride block's notes (owner 2026-10-22): as much as the block's height leaves — the block's own flex column
 * shrinks this part first, so the label and the time stay — instead of a fixed two lines. When the text is cut,
 * the bottom fades out and the element carries `data-truncated` (the click popup shows the whole text).
 */
export function RideNotes({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.scrollHeight > el.clientHeight + 1) el.setAttribute(TRUNCATED_ATTR, "");
      else el.removeAttribute(TRUNCATED_ATTR);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span
      ref={ref}
      {...{ [RIDE_NOTES_ATTR]: "" }}
      className={cn(
        "flex min-h-0 w-full shrink flex-col overflow-hidden",
        "data-[truncated]:[mask-image:linear-gradient(to_bottom,black_calc(100%-0.9rem),transparent)]",
        className,
      )}
    >
      {children}
    </span>
  );
}
