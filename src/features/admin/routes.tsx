import type { RouteObject } from "react-router-dom";

import { AdminHomePage } from "@/pages/admin/AdminHomePage";
import { CarDetailPage } from "@/pages/admin/CarDetailPage";
import { CarsPage } from "@/pages/admin/CarsPage";
import { DepartmentsPage } from "@/pages/admin/DepartmentsPage";
import { DestinationsPage } from "@/pages/admin/DestinationsPage";
import { IssuesPage } from "@/pages/admin/IssuesPage";
import { MaintenancePage } from "@/pages/admin/MaintenancePage";
import { MembersPage } from "@/pages/admin/MembersPage";
import { PoliciesPage } from "@/pages/admin/PoliciesPage";
import { PolicyDetailPage } from "@/pages/admin/PolicyDetailPage";
import { RideTypesPage } from "@/pages/admin/RideTypesPage";
import { RosterPage } from "@/pages/admin/RosterPage";
import { SettingsPage } from "@/pages/admin/SettingsPage";
import { TemplatesPage } from "@/pages/admin/TemplatesPage";

/**
 * Admin route list (UX_FLOWS.md §2.1), spread as-is into `src/app/router.tsx`
 * under the existing `RequireAdmin` element (a layout route with no `path`
 * of its own, already nested inside `AppShell`) — so every path below is
 * absolute, matching the router's existing convention for `/my`, `/siddur`, …
 */
export const adminRoutes: RouteObject[] = [
  { path: "/admin", element: <AdminHomePage /> },
  { path: "/admin/departments", element: <DepartmentsPage /> },
  { path: "/admin/members", element: <MembersPage /> },
  { path: "/admin/roster", element: <RosterPage /> },
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
