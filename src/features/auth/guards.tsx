import { Navigate, Outlet, useLocation } from "react-router-dom";

import { t } from "@/i18n/he";

import { useIsSadranAnywhere } from "./useIsSadran";
import { useProfile } from "./useProfile";
import { useSession } from "./useSession";

/** Full-screen loading placeholder while a guard's query is in flight. */
function GuardLoading() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
      {t("common.loading")}
    </div>
  );
}

/** No session → `/login` (UX_FLOWS.md §2.1). */
export function RequireAuth() {
  const { session, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <GuardLoading />;
  if (!session) return <Navigate to="/login" state={{ from: location }} replace />;
  return <Outlet />;
}

/**
 * Signed in but not yet approved (or blocked) → `/pending` (UX_FLOWS.md
 * §3.1). Deliberately does not also gate on `phone` — the onboarding route
 * itself sits behind this guard and must stay reachable for an approved
 * member who hasn't set a phone yet (see `RequireOnboarded`).
 */
export function RequireApproved() {
  const profileQuery = useProfile();

  if (profileQuery.isLoading) return <GuardLoading />;
  if (profileQuery.data?.approval_status !== "approved") {
    return <Navigate to="/pending" replace />;
  }
  return <Outlet />;
}

/** Approved but `profile.phone` missing → `/onboarding` (UX_FLOWS.md §3.2). */
export function RequireOnboarded() {
  const profileQuery = useProfile();

  if (profileQuery.isLoading) return <GuardLoading />;
  if (!profileQuery.data?.phone) {
    return <Navigate to="/onboarding" replace />;
  }
  return <Outlet />;
}

/**
 * Not Sadran of any department for its open/live week → `/my`. This stage
 * has no `/sadran/:dept/:week` routes yet, so the check is "Sadran of
 * anything I belong to right now" rather than a specific dept/week.
 */
export function RequireSadran() {
  const { isSadran, isLoading } = useIsSadranAnywhere();

  if (isLoading) return <GuardLoading />;
  if (!isSadran) return <Navigate to="/my" replace />;
  return <Outlet />;
}

/** Not `profile.is_admin` → `/my`. */
export function RequireAdmin() {
  const profileQuery = useProfile();

  if (profileQuery.isLoading) return <GuardLoading />;
  if (!profileQuery.data?.is_admin) return <Navigate to="/my" replace />;
  return <Outlet />;
}
