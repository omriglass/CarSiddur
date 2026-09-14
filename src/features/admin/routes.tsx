import type { RouteObject } from "react-router-dom";

import {
  AdminHomePage,
  CarDetailPage,
  CarsPage,
  DepartmentsPage,
  DestinationsPage,
  IssuesPage,
  MaintenancePage,
  MembersPage,
  PoliciesPage,
  PolicyDetailPage,
  RideTypesPage,
  RosterPage,
  SettingsPage,
  TemplatesPage,
} from "./lazyPages";

/**
 * Admin route list (UX_FLOWS.md §2.1), spread as-is into `src/app/router.tsx`
 * under the existing `RequireAdmin` element (a layout route with no `path`
 * of its own, already nested inside `AppShell`) — so every path below is
 * absolute, matching the router's existing convention for `/my`, `/siddur`, …
 */
export const adminRoutes: RouteObject[] = [
  { path: "/admin/departments", element: <DepartmentsPage /> },
  { path: "/admin/members", element: <MembersPage /> },
  { path: "/admin/roster", element: <RosterPage /> },
];

export const operationsRoutes: RouteObject[] = [
  { path: "/admin", element: <AdminHomePage /> },
  { path: "/admin/cars", element: <CarsPage /> },
  { path: "/admin/cars/:id", element: <CarDetailPage /> },
  { path: "/admin/maintenance", element: <MaintenancePage /> },
  { path: "/admin/issues", element: <IssuesPage /> },
  { path: "/admin/destinations", element: <DestinationsPage /> },
  { path: "/admin/ride-types", element: <RideTypesPage /> },
  { path: "/admin/policies", element: <PoliciesPage /> },
  { path: "/admin/policies/:id", element: <PolicyDetailPage /> },
  { path: "/admin/templates", element: <TemplatesPage /> },
  { path: "/admin/settings", element: <SettingsPage /> },
];
