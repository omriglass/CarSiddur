import type { RouteObject } from "react-router-dom";

import { CarPage } from "@/pages/CarPage";
import { EditRequestPage } from "@/pages/EditRequestPage";
import { RequestsListPage } from "@/pages/RequestsListPage";
import { SiddurArchivePage } from "@/pages/SiddurArchivePage";
import { SiddurPage } from "@/pages/SiddurPage";
import { StatsPage } from "@/pages/StatsPage";

/**
 * Member-facing routes added in stage 2a, beyond the pre-existing literal
 * entries in `src/app/router.tsx` (`/requests/new`, `/siddur`, `/inbox`,
 * `/profile`, which already point at their real pages). Spread as a single
 * `...memberRoutes` line inside the `AppShell` route's `children` array so a
 * concurrent admin-screens stage editing the same file only collides with
 * one line, not a restructured route tree (stage 2a coordination note).
 */
export const memberRoutes: RouteObject[] = [
  { path: "/requests", element: <RequestsListPage /> },
  { path: "/requests/:id/edit", element: <EditRequestPage /> },
  { path: "/siddur/:dept", element: <SiddurPage /> },
  { path: "/siddur/:dept/archive", element: <SiddurArchivePage /> },
  { path: "/siddur/:dept/:week", element: <SiddurPage /> },
  { path: "/cars/:carId", element: <CarPage /> },
  { path: "/stats/:dept", element: <StatsPage /> },
];
