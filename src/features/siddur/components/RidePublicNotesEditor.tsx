import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { he } from "@/i18n/he";
import { useUpdateRidePublicNotesMutation } from "../hooks";

/** Metadata can be saved independently of any proposed schedule changes. */
export function RidePublicNotesEditor({ rideId, expectedVersion, initialNotes }: {
  rideId: string;
  expectedVersion: number;
  initialNotes: string | null;
}) {
  const [notes, setNotes] = useState(initialNotes ?? "");
  const mutation = useUpdateRidePublicNotesMutation();
  const changed = notes.trim() !== (initialNotes?.trim() ?? "");
  const fieldId = `ride-public-notes-${rideId}`;
  return (
    <form className="space-y-2 rounded-md border p-3" onSubmit={(event) => {
      event.preventDefault();
      if (!changed || mutation.isPending) return;
      mutation.mutate({ rideId, expectedVersion, notes: notes.trim() || null }, {
        onSuccess: () => toast.success(he.ridePublicDetails.saved),
      });
    }}>
      <Label htmlFor={fieldId}>{he.ridePublicDetails.label}</Label>
      <Textarea id={fieldId} rows={3} maxLength={1000} value={notes} disabled={mutation.isPending} onChange={(event) => setNotes(event.target.value)} aria-describedby={`${fieldId}-help`} />
      <p id={`${fieldId}-help`} className="text-xs text-muted-foreground">{he.ridePublicDetails.help}</p>
      <Button type="submit" disabled={!changed || mutation.isPending}>{he.ridePublicDetails.save}</Button>
    </form>
  );
}
