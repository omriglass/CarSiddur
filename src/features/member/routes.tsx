import { Suspense } from "react";
import type { RouteObject } from "react-router-dom";

import { GuardLoading } from "@/features/auth/guards";
import { RequestsRedirect } from "@/pages/RequestsRedirect";
import { CarChecklistEditorPage, CarPage, CarsOverviewPage, MyArchivePage, MyHistoryPage, PlanningPage, PolicyPage, ReservationFormPage, SiddurArchivePage, SiddurPage, StatsPage } from "./lazyPages";


/**
 * Member-facing routes added in stage 2a, beyond the pre-existing literal
 * entries in `src/app/router.tsx` (`/requests/new`, `/siddur`, `/inbox`,
 * `/profile`, which already point at their real pages). Spread as a single
 * `...memberRoutes` line inside the `AppShell` route's `children` array so a
 * concurrent admin-screens stage editing the same file only collides with
 * one line, not a restructured route tree (stage 2a coordination note).
 *
 * `/requests` used to render the standalone requests list (`RequestsListPage`); that screen
 * was folded into `/my` (Home) as its one "my rides" list (REQ §13 item 91, owner 2026-09-16,
 * E3) — the route now just redirects there, preserving `?focus=`.
 */
export const memberRoutes: RouteObject[] = [
  { path: "/requests", element: <RequestsRedirect /> },
  { path: "/my/archive", element: <Suspense fallback={<GuardLoading />}><MyArchivePage /></Suspense> },
  { path: "/my/history", element: <Suspense fallback={<GuardLoading />}><MyHistoryPage /></Suspense> },
  { path: "/siddur/:dept", element: <Suspense fallback={<GuardLoading />}><SiddurPage /></Suspense> },
  { path: "/siddur/:dept/archive", element: <Suspense fallback={<GuardLoading />}><SiddurArchivePage /></Suspense> },
  { path: "/siddur/:dept/:week", element: <Suspense fallback={<GuardLoading />}><SiddurPage /></Suspense> },
  { path: "/cars", element: <Suspense fallback={<GuardLoading />}><CarsOverviewPage /></Suspense> },
  { path: "/cars/checklist/:dept", element: <Suspense fallback={<GuardLoading />}><CarChecklistEditorPage /></Suspense> },
  { path: "/cars/:carId", element: <Suspense fallback={<GuardLoading />}><CarPage /></Suspense> },
  { path: "/stats/:dept", element: <Suspense fallback={<GuardLoading />}><StatsPage /></Suspense> },
  { path: "/policy/:dept", element: <Suspense fallback={<GuardLoading />}><PolicyPage /></Suspense> },
  { path: "/plan/:dept", element: <Suspense fallback={<GuardLoading />}><PlanningPage /></Suspense> },
  { path: "/plan/:dept/new", element: <Suspense fallback={<GuardLoading />}><ReservationFormPage /></Suspense> },
  { path: "/plan/:dept/:reservationId/edit", element: <Suspense fallback={<GuardLoading />}><ReservationFormPage /></Suspense> },
];
