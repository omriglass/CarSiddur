import { Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import { ErrorScreen } from "@/app/ErrorScreen";
import {
  GuardLoading,
  RequireAdmin,
  RequireOperations,
  RequireApproved,
  RequireAuth,
  RequireOnboarded,
  RequireSadran,
} from "@/features/auth/guards";
import { adminRoutes, operationsRoutes } from "@/features/admin/routes";
import { memberRoutes } from "@/features/member/routes";
import { sadranRoutes } from "@/features/sadran/routes";
import { HomePage } from "@/pages/HomePage";
import { InboxPage } from "@/pages/InboxPage";
import { LoginPage } from "@/pages/LoginPage";
import { NewRequestPage } from "@/pages/NewRequestPage";
import { NotFoundPage } from "@/pages/NotFoundPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { PendingPage } from "@/pages/PendingPage";
import { ProfilePage } from "@/pages/ProfilePage";
import { ProposalTokenPage } from "@/pages/ProposalTokenPage";
import { SiddurPage } from "@/pages/SiddurPage";

// Route list from UX_FLOWS.md §2.1, nested under the auth guards (features/auth/guards.tsx):
// RequireAuth (no session -> /login) > RequireApproved (not approved -> /pending) >
// [ /onboarding, unguarded further ] and [ RequireOnboarded (no phone -> /onboarding) > AppShell ].
// `/login`, `/pending` and `/p/:token` render outside every guard (no-session/no-approval screens).
//
// The outermost entry is a single pathless layout route whose only job is
// `errorElement` (UX_FLOWS.md §2.3): any render exception thrown by a
// descendant route bubbles up to the nearest ancestor route that declares
// one, so one `errorElement` here catches every route below without
// duplicating it per branch. It has no `element` of its own beyond
// `<Outlet />` so every path/pattern below is unchanged.
export const router = createBrowserRouter([
  {
    errorElement: <ErrorScreen />,
    element: <Outlet />,
    children: [
      {
        element: <RequireAuth />,
        children: [
          {
            element: <RequireApproved />,
            children: [
              { path: "/onboarding", element: <OnboardingPage /> },
              {
                element: <RequireOnboarded />,
                children: [
                  {
                    element: <AppShell />,
                    children: [
                      { path: "/", element: <Navigate to="/my" replace /> },
                      { path: "/my", element: <HomePage /> },
                      { path: "/requests/new", element: <NewRequestPage /> },
                      { path: "/siddur", element: <SiddurPage /> },
                      { path: "/inbox", element: <InboxPage /> },
                      { path: "/profile", element: <ProfilePage /> },
                      ...memberRoutes,
                      {
                        element: <RequireSadran />,
                        // One `<Suspense>` boundary for the whole lazily-loaded
                        // Sadran area (board/proposals/publish/…, `sadranRoutes`
                        // itself does the `React.lazy()` per page) rather than one
                        // per route — docs/HARDENING_2026-09.md §3 item 2.
                        children: [{ element: <Suspense fallback={<GuardLoading />}><Outlet /></Suspense>, children: [...sadranRoutes] }],
                      },
                      {
                        element: <RequireOperations />,
                        children: [{ element: <Suspense fallback={<GuardLoading />}><Outlet /></Suspense>, children: [...operationsRoutes] }],
                      },
                      {
                        element: <RequireAdmin />,
                        children: [{ element: <Suspense fallback={<GuardLoading />}><Outlet /></Suspense>, children: [...adminRoutes] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: "/login", element: <LoginPage /> },
      { path: "/pending", element: <PendingPage /> },
      { path: "/p/:token", element: <ProposalTokenPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
