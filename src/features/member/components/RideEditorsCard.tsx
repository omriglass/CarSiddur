// REQ §13.202: "מי יכול/ה לערוך את הנסיעות שלי" in Profile → פרטים אישיים — the people of my department I let edit and
// cancel my requests and rides (saved as one list), and, read-only, the people who let me edit theirs. A child's other
// guardian edits without being named (REQ §13.202 i): listed as "הורה משותף", no ×.
import { useState } from "react";
import { toast } from "sonner";

import { CompanionPicker } from "@/components/CompanionPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDepartmentMembers } from "@/features/auth/useDepartmentMembers";
import { he, tv } from "@/i18n/he";

import type { RideEditorLink } from "../api";
import { useRideEditorsQuery, useSetRideEditorsMutation } from "../hooks";

export interface RideEditorsCardViewProps {
  members: readonly { id: string; name: string }[];
  /** My editors in this department (the list I named). */
  saved: readonly string[];
  /** REQ §13.202 (i): who edits my rides through a child we share (not on the list, not removable). */
  coParents?: readonly RideEditorLink[];
  grantedToMe: readonly RideEditorLink[];
  saving: boolean;
  onSave: (editorIds: string[]) => void;
}

const coParentName = (link: RideEditorLink) => (link.coParent ? tv("profileExtra.rideEditorsCoParent", { name: link.person.name }) : link.person.name);

export function RideEditorsCardView({ members, saved, coParents = [], grantedToMe, saving, onSave }: RideEditorsCardViewProps) {
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
        {coParents.length ? (
          <ul className="space-y-1 text-sm" data-testid="ride-editors-co-parents">
            {coParents.map((link) => <li key={link.person.id}>{coParentName(link)}</li>)}
          </ul>
        ) : null}
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
              {grantedToMe.map((link) => <li key={link.person.id}>{coParentName(link)}</li>)}
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
      saved={editorsQuery.data.mine.filter((link) => inDepartment(link) && link.named).map((link) => link.person.id)}
      coParents={editorsQuery.data.mine.filter((link) => inDepartment(link) && link.coParent && !link.named)}
      grantedToMe={editorsQuery.data.grantedToMe.filter(inDepartment)}
      saving={mutation.isPending}
      onSave={(editorIds) => mutation.mutate({ departmentId, editorIds }, { onSuccess: () => toast.success(he.profileExtra.rideEditorsSaved) })}
    />
  );
}
