import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useIsSadranAnywhere } from "@/features/auth/useIsSadran";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { inboxKeys } from "@/features/inbox/queryKeys";
import { CHANGELOG } from "@/i18n/he.changelog";

import { deliverChangelog } from "./api";
import { inboxMessage } from "./changelog";

/** Entries already handed to the server in this page load, per profile (`<profileId>:<entryId>`). */
const handedOver = new Set<string>();

/**
 * REQ §13.139 (b): the first time a signed-in, approved member opens a version with a new changelog entry, its
 * "מה חדש" message (their sections only) lands in their inbox — no push. One call per page load; the server dedupes
 * per entry (`changelog:<id>`), so the server — not the device — is the record of what was delivered.
 */
export function useDeliverChangelog(): void {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const profileId = session?.user.id;
  const profile = useProfile().data;
  const { isSadran, isLoading } = useIsSadranAnywhere();
  useEffect(() => {
    const latest = CHANGELOG[0];
    if (!latest || !profileId || !profile || isLoading || profile.approval_status !== "approved") return;
    const key = `${profileId}:${latest.id}`;
    if (handedOver.has(key)) return;
    handedOver.add(key);
    const message = inboxMessage(latest, { isSadran, isAdmin: !!profile.is_admin });
    if (!message) return;
    deliverChangelog(latest.id, message.title, message.body)
      .then((added) => {
        if (added) void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      })
      .catch(() => { handedOver.delete(key); });
  }, [profileId, profile, isSadran, isLoading, queryClient]);
}
