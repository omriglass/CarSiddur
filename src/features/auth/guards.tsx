import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useCanManageOperations } from "@/features/admin/useOperations";

import { t } from "@/i18n/he";

import { useIsSadranAnywhere } from "./useIsSadran";
import { useProfile } from "./useProfile";
import { useSession } from "./useSession";

/**
 * Full-screen loading placeholder while a guard's query is in flight — also
 * reused as the `<Suspense fallback>` for the lazily-loaded heavy area route
 * trees (Sadran, admin, operations; `src/app/router.tsx`,
 * docs/HARDENING_2026-09.md §3 item 2), so a pending guard and a pending
 * route chunk download look identical rather than one being a blank screen.
 */
export function GuardLoading() {
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

/** Active coordinator entry point; each week route also checks its own authorization. */
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


/** Operational administration excludes departments, users and role assignments. */
export function RequireOperations() {
  const access = useCanManageOperations();
  if (access.isLoading) return <GuardLoading />;
  if (!access.data) return <Navigate to="/my" replace />;
  return <Outlet />;
}
