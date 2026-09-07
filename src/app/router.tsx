import { createBrowserRouter, Navigate } from "react-router-dom";

import { AppShell } from "@/app/AppShell";
import {
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
export const router = createBrowserRouter([
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
                    children: [...sadranRoutes],
                  },
                  {
                    element: <RequireOperations />,
                    children: [...operationsRoutes],
                  },
                  {
                    element: <RequireAdmin />,
                    children: [...adminRoutes],
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
]);
