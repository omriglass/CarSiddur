// REQ §13.202: "מי יכול/ה לערוך את הנסיעות שלי" in Profile → פרטים אישיים — the people of my department I let edit and
// cancel my requests and rides (saved as one list), and, read-only, the people who let me edit theirs.
import { useState } from "react";
import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { he } from "@/i18n/he";

import type { RideEditorLink } from "../api";
import { useRideEditorsQuery, useSetRideEditorsMutation } from "../hooks";

export interface RideEditorsCardViewProps {
  members: readonly { id: string; name: string }[];
  /** My editors in this department. */
  saved: readonly string[];
  grantedToMe: readonly RideEditorLink[];
  saving: boolean;
  onSave: (editorIds: string[]) => void;
}

export function RideEditorsCardView({ members, saved, grantedToMe, saving, onSave }: RideEditorsCardViewProps) {
  // The draft follows the saved list until the member changes it (the same "adjust state to new data" idiom as the forms).
  const [draft, setDraft] = useState<string[] | null>(null);
  const [savedKey, setSavedKey] = useState(saved.join(","));
  if (savedKey !== saved.join(",")) {
    setSavedKey(saved.join(","));
    setDraft(null);
  }
  const value = draft ?? [...saved];
  const changed = [...value].sort().join(",") !== [...saved].sort().join(",");
  return (
    <Card data-testid="profile-ride-editors">
      <CardHeader>
        <CardTitle className="text-base">{he.profileExtra.rideEditorsTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{he.profileExtra.rideEditorsHint}</p>
        <CompanionPicker members={members} value={value} onChange={setDraft} label={he.profileExtra.rideEditorsPicker} />
        {changed ? (
          <Button type="button" className="min-h-11" disabled={saving} onClick={() => onSave(value)} data-testid="ride-editors-save">
            {he.profileExtra.rideEditorsSave}
          </Button>
        ) : null}
        {grantedToMe.length ? (
          <div className="space-y-1 border-t pt-3" data-testid="ride-editors-granted">
            <p className="text-sm font-medium">{he.profileExtra.rideEditorsGrantedTitle}</p>
            <ul className="space-y-1 text-sm">
              {grantedToMe.map((link) => <li key={link.person.id}>{link.person.name}</li>)}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RideEditorsCard({ departmentId }: { departmentId: string | undefined }) {
  const membersQuery = useDepartmentMembers(departmentId);
  const editorsQuery = useRideEditorsQuery();
  const mutation = useSetRideEditorsMutation();
  if (!departmentId || !editorsQuery.data || !membersQuery.data) return null;
  const inDepartment = (link: RideEditorLink) => link.departmentId === departmentId;
  return (
    <RideEditorsCardView
      members={membersQuery.data.map((member) => ({ id: member.id, name: member.name }))}
      saved={editorsQuery.data.mine.filter(inDepartment).map((link) => link.person.id)}
      grantedToMe={editorsQuery.data.grantedToMe.filter(inDepartment)}
      saving={mutation.isPending}
      onSave={(editorIds) => mutation.mutate({ departmentId, editorIds }, { onSuccess: () => toast.success(he.profileExtra.rideEditorsSaved) })}
    />
  );
}
