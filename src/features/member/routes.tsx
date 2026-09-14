import { Suspense } from "react";
import type { RouteObject } from "react-router-dom";

import { GuardLoading } from "@/features/auth/guards";
import { CarPage, EditRequestPage, RequestsListPage, SiddurArchivePage, SiddurPage, StatsPage } from "./lazyPages";


/**
 * Member-facing routes added in stage 2a, beyond the pre-existing literal
 * entries in `src/app/router.tsx` (`/requests/new`, `/siddur`, `/inbox`,
 * `/profile`, which already point at their real pages). Spread as a single
 * `...memberRoutes` line inside the `AppShell` route's `children` array so a
 * concurrent admin-screens stage editing the same file only collides with
 * one line, not a restructured route tree (stage 2a coordination note).
 */
export const memberRoutes: RouteObject[] = [
  { path: "/requests", element: <Suspense fallback={<GuardLoading />}><RequestsListPage /></Suspense> },
  { path: "/requests/:id/edit", element: <Suspense fallback={<GuardLoading />}><EditRequestPage /></Suspense> },
  { path: "/siddur/:dept", element: <Suspense fallback={<GuardLoading />}><SiddurPage /></Suspense> },
  { path: "/siddur/:dept/archive", element: <Suspense fallback={<GuardLoading />}><SiddurArchivePage /></Suspense> },
  { path: "/siddur/:dept/:week", element: <Suspense fallback={<GuardLoading />}><SiddurPage /></Suspense> },
  { path: "/cars/:carId", element: <Suspense fallback={<GuardLoading />}><CarPage /></Suspense> },
  { path: "/stats/:dept", element: <Suspense fallback={<GuardLoading />}><StatsPage /></Suspense> },
];
