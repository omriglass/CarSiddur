import { Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { CharCount } from "@/components/CharCount";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { useUpdateRidePublicNotesMutation } from "../hooks";

/** Metadata can be saved independently of any proposed schedule changes. */
export function RidePublicNotesEditor({ rideId, expectedVersion, initialNotes, departmentId, weekStart, onDone }: {
  rideId: string;
  expectedVersion: number;
  initialNotes: string | null;
  /** The ride's own `department_id`/`week_start` — scopes cache invalidation after saving. */
  departmentId: string;
  weekStart: string;
  /** Opened from the notes on the ride sheet: a cancel button, and closes after saving. */
  onDone?: () => void;
}) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const mutation = useUpdateRidePublicNotesMutation();
  const changed = notes.trim() !== (initialNotes?.trim() ?? "");
  const fieldId = `ride-public-notes-${rideId}`;
  return (
    <form className="space-y-2 rounded-md border p-3" onSubmit={(event) => {
      event.preventDefault();
      if (!changed || mutation.isPending) return;
      mutation.mutate({ rideId, expectedVersion, notes: notes.trim() || null, departmentId, weekStart }, {
        onSuccess: () => { toast.success(he.ridePublicDetails.saved); onDone?.(); },
      });
    }}>
      <Label htmlFor={fieldId}>{he.ridePublicDetails.label}</Label>
      <Textarea id={fieldId} autoFocus={!!onDone} rows={3} maxLength={1000} value={notes} disabled={mutation.isPending} onChange={(event) => setNotes(event.target.value)} aria-describedby={`${fieldId}-help`} />
      <CharCount value={notes} max={1000} />
      <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">{he.ridePublicDetails.help}</p>
      <div className="flex gap-2">
        <Button type="submit" disabled={!changed || mutation.isPending}>{he.ridePublicDetails.save}</Button>
        {onDone ? <Button type="button" variant="ghost" disabled={mutation.isPending} onClick={onDone}>{he.common.cancel}</Button> : null}
      </div>
    </form>
  );
}

/**
 * Owner 2026-11-16: on the ride sheet the notes for everyone are shown as text that opens the editor when tapped (a pencil
 * says so); with no notes yet, a small "+ הוספת מידע לכולם".
 */
export function EditableRideNotes(props: { rideId: string; expectedVersion: number; notes: string | null; departmentId: string; weekStart: string }) {
  const [editing, setEditing] = useState(false);
  const text = props.notes?.trim();
  if (editing) {
    return <RidePublicNotesEditor rideId={props.rideId} expectedVersion={props.expectedVersion} initialNotes={props.notes} departmentId={props.departmentId} weekStart={props.weekStart} onDone={() => setEditing(false)} />;
  }
  if (!text) {
    return (
      <button type="button" className="flex items-center gap-1 text-sm font-medium text-primary hover:underline" onClick={() => setEditing(true)} data-testid="ride-notes-add">
        <Plus className="size-4" aria-hidden="true" />
        {he.ridePublicDetails.add}
      </button>
    );
  }
  return (
    <button type="button" className="-mx-2 flex w-[calc(100%+1rem)] items-start gap-2 rounded-md px-2 py-1 text-start hover:bg-muted" onClick={() => setEditing(true)}
      aria-label={he.ridePublicDetails.editAria} data-testid="ride-notes-edit">
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
      <Pencil className="mt-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}
