import { Navigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useProfile } from "@/features/auth/useProfile";
import { useSession } from "@/features/auth/useSession";
import { t } from "@/i18n/he";
import { supabase } from "@/integrations/supabase/client";

const POLL_INTERVAL_MS = 30_000;

/**
 * `/pending` (UX_FLOWS.md §3.1): wait-for-approval page for an unknown
 * Google account (or one an admin blocked). Polls the profile every 30 s;
 * the copy makes **no promise of an email** — decided 2026-09-06,
 * REQUIREMENTS §13.60 — a never-onboarded member has no push subscription
 * and the email channel is v1.x.
 */
export function PendingPage() {
  const { session } = useSession();
  const profileQuery = useProfile({ refetchInterval: POLL_INTERVAL_MS });

  if (profileQuery.data?.approval_status === "approved") {
    return <Navigate to="/my" replace />;
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center p-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("screen.pending.title")}</CardTitle>
          <CardDescription>{t("pending.body")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {session?.user.email ? (
            <p className="text-sm text-muted-foreground">
              {t("pending.signedInAs")} <span dir="ltr">{session.user.email}</span>
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button onClick={() => profileQuery.refetch()}>{t("action.checkAgain")}</Button>
            <Button variant="outline" onClick={handleSignOut}>
              {t("action.useDifferentAccount")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
