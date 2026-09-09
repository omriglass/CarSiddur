import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { he } from "@/i18n/he";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Extra body content between the description and the footer (e.g. a picker, a list). */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm button as `variant="destructive"` (deletes, cancellations, unpublishing). */
  destructive?: boolean;
  /** Disables both buttons and blocks closing via overlay/Escape while a mutation is in flight. */
  loading?: boolean;
  /** Extra condition (besides `loading`) that keeps the confirm button disabled. */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  className?: string;
}

/**
 * Shared confirm/cancel dialog (docs/REFACTOR_BACKLOG.md §2.1). Every
 * "are you sure" flow should render through this instead of hand-rolling
 * `Dialog`+`DialogHeader`+`DialogFooter`. `window.confirm` should never be
 * used — this is its replacement.
 *
 * Mobile-first: footer buttons are full-width and stacked below `sm`, side
 * by side from `sm` up (matches `DialogFooter`'s own breakpoint). `dir` is
 * inherited from the ambient `<html dir="rtl">` — never set here.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = he.common.confirm,
  cancelLabel = he.common.cancel,
  destructive = false,
  loading = false,
  confirmDisabled = false,
  onConfirm,
  className,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next); }}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-auto"
            disabled={loading}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            className="w-full sm:w-auto"
            disabled={loading || confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
