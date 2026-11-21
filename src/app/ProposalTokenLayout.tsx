import { Outlet } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { useSession } from "@/features/auth/useSession";

/** PX1 (owner 2026-11-21): `/p/:token` signed in keeps the app's usual top bar / bottom row; without a session it stands alone. */
export function ProposalTokenLayout() {
  const { session, isLoading } = useSession();
  if (isLoading) return null;
  return session ? <AppShell /> : <Outlet />;
}
