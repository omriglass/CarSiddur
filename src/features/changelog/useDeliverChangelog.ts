import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useIsSadranAnywhere } from "@/features/auth/useIsSadran";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { inboxKeys } from "@/features/inbox/queryKeys";
import { CHANGELOG } from "@/i18n/he.changelog";

import { deliverChangelog } from "./api";
import { inboxMessage } from "./changelog";

const storageKey = (profileId: string) => `changelog-delivered:${profileId}`;

/**
 * REQ §13.139 (b): the first time a signed-in, approved member opens a version with a new changelog entry, its
 * "מה חדש" message (their sections only) lands in their inbox — no push. The server dedupes per entry; the device
 * remembers what it already handed over so this is one call per new version, not one per page load.
 */
export function useDeliverChangelog(): void {
  const queryClient = useQueryClient();
  const { session } = useSession();
  const profileId = session?.user.id;
  const profile = useProfile().data;
  const { isSadran, isLoading } = useIsSadranAnywhere();
  const started = useRef<string | null>(null);

  useEffect(() => {
    const latest = CHANGELOG[0];
    if (!latest || !profileId || !profile || isLoading || profile.approval_status !== "approved") return;
    let done: string | null = null;
    try { done = localStorage.getItem(storageKey(profileId)); } catch { /* storage unavailable: the server dedupes */ }
    if (done === latest.id || started.current === `${profileId}:${latest.id}`) return;
    started.current = `${profileId}:${latest.id}`;
    const remember = () => {
      try { localStorage.setItem(storageKey(profileId), latest.id); } catch { /* ignore */ }
    };
    const message = inboxMessage(latest, { isSadran, isAdmin: !!profile.is_admin });
    if (!message) { remember(); return; }
    deliverChangelog(latest.id, message.title, message.body)
      .then(() => {
        remember();
        void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      })
      .catch(() => { started.current = null; });
  }, [profileId, profile, isSadran, isLoading, queryClient]);
}
