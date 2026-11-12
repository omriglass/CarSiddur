import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * A dialog that never grows past the screen (TODO DL1): `DIALOG_FIT` on the `DialogContent`, the header
 * and the action buttons as its direct children, and everything between them inside `DialogBody` — the
 * only part that scrolls, so the title, the ✕ and the buttons stay in reach on a short phone screen.
 */
export const DIALOG_FIT = "flex max-h-[90dvh] flex-col";

export function DialogBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // The side padding keeps focus rings from being clipped by the scroll container.
  return <div className={cn("-mx-1 grid min-h-0 gap-4 overflow-y-auto overscroll-contain px-1", className)} {...props} />;
}
