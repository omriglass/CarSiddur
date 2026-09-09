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

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Form fields / body content. */
  children: ReactNode;
  onSubmit: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  /** Disables both buttons while a mutation is in flight. */
  loading?: boolean;
  /** Extra condition (besides `loading`) that keeps the submit button disabled, e.g. validation. */
  submitDisabled?: boolean;
  className?: string;
  /** Escape hatch for a non-standard footer; when omitted, renders the default cancel/submit pair. */
  footer?: ReactNode;
}

/**
 * Shared "edit this row" dialog (docs/REFACTOR_BACKLOG.md §2.1). Every
 * add/edit form-in-a-dialog flow should render through this instead of
 * hand-rolling `Dialog`+`DialogHeader`+`DialogFooter` with its own
 * Cancel+Save pair.
 *
 * Mobile-first: footer buttons are full-width and stacked below `sm`, side
 * by side from `sm` up (matches `DialogFooter`'s own breakpoint). `dir` is
 * inherited from the ambient `<html dir="rtl">` — never set here.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  onSubmit,
  submitLabel = he.common.save,
  cancelLabel = he.common.cancel,
  loading = false,
  submitDisabled = false,
  className,
  footer,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next); }}>
      <DialogContent className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          {footer ?? (
            <>
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
                className="w-full sm:w-auto"
                disabled={loading || submitDisabled}
                onClick={onSubmit}
              >
                {submitLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
