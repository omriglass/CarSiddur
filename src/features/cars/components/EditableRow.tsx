import { Check, Loader2, Pencil, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";
import { cn } from "@/lib/utils";

export interface EditorProps<T> {
  draft: T;
  setDraft: (next: T) => void;
  /** The id of the editor's first control (the row's label points at it). */
  inputId: string;
}

interface EditableRowProps<T> {
  label: string;
  testId?: string;
  /** What the row shows at rest. */
  value: ReactNode;
  /** Whether the viewer may edit this field (RLS re-checks every write). */
  editable: boolean;
  /** The draft the editor starts from each time it opens. */
  initial: T;
  editor: (props: EditorProps<T>) => ReactNode;
  /** A message when the draft cannot be saved, else null. */
  validate?: (draft: T) => string | null;
  onSave: (draft: T) => Promise<void>;
}

/**
 * CR1 (REQ item 257, owner 2026-11-20): one car detail, edited in place. At rest it reads "label / value" with a small
 * pencil for whoever may edit; the pencil (or a tap on the value) turns the value into its editor with ✓ / ✕ — Enter
 * saves, Escape cancels. Only the changed field is saved.
 */
export function EditableRow<T>({ label, testId, value, editable, initial, editor, validate, onSave }: EditableRowProps<T>) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<T>(initial);
  const [saving, setSaving] = useState(false);
  const error = editing && validate ? validate(draft) : null;

  function open() {
    setDraft(initial);
    setEditing(true);
  }

  async function save() {
    if (error || saving) return;
    setSaving(true);
    try {
      await onSave(draft);
      toast.success(he.adminCommon.savedToast);
      setEditing(false);
    } catch (caught) {
      showErrorToast(caught);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0" data-testid={testId} data-editing={editing ? "true" : undefined}>
      <dt className="text-xs text-muted-foreground">
        {editing ? <label htmlFor={inputId}>{label}</label> : label}
      </dt>
      {editing ? (
        <dd>
          <form
            className="flex flex-col gap-1.5"
            onSubmit={(event) => { event.preventDefault(); void save(); }}
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setEditing(false); } }}
          >
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">{editor({ draft, setDraft, inputId })}</div>
              <Button type="submit" size="icon" className="size-9 shrink-0" disabled={!!error || saving} aria-label={he.carPage.saveField} data-testid={testId ? `${testId}-save` : undefined}>
                {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Check className="size-4" aria-hidden="true" />}
              </Button>
              <Button type="button" size="icon" variant="ghost" className="size-9 shrink-0" onClick={() => setEditing(false)} aria-label={he.carPage.cancelField}>
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
            {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
          </form>
        </dd>
      ) : (
        <dd className="flex items-start justify-between gap-2 text-sm text-foreground">
          {editable ? (
            <button type="button" className="min-w-0 flex-1 rounded text-start hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={open}>
              {value}
            </button>
          ) : (
            <span className="min-w-0 flex-1">{value}</span>
          )}
          {editable ? (
            <button
              type="button"
              className={cn("-my-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
              onClick={open}
              aria-label={`${he.carPage.editField}: ${label}`}
              data-testid={testId ? `${testId}-edit` : undefined}
            >
              <Pencil className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </dd>
      )}
    </div>
  );
}

/** A plain detail row (nobody edits it here). */
export function DetailRow({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b py-2 last:border-b-0" data-testid={testId}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}
