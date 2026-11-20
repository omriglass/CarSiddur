// REQ item 258 (b): the admin opts a member in to "לכתוב במילים" (members editor). Saved at once, not with the dialog.
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { he } from "@/i18n/he";
import { showErrorToast } from "@/lib/rpc";

import { useAdminSetAskAccessMutation, useAskAccess } from "../hooks";

export function AdminAskAccessSwitch({ profileId }: { profileId: string }) {
  const access = useAskAccess(profileId);
  const setAccess = useAdminSetAskAccessMutation();
  return (
    <div className="flex items-center justify-between gap-2">
      <Label htmlFor="admin-member-ask-access">{he.ask.adminSwitch}</Label>
      <Switch id="admin-member-ask-access" data-testid="admin-member-ask-access"
        checked={!!access.data}
        disabled={access.isLoading || setAccess.isPending}
        onCheckedChange={(checked) => setAccess.mutate({ profileId, enabled: checked }, { onError: showErrorToast })} />
    </div>
  );
}
