import { lazy } from "react";
import type { RouteObject } from "react-router-dom";

// Lazily loaded (docs/HARDENING_2026-09.md §3 item 2): the admin/operations
// screens are a heavy area only admins/operations managers ever reach, so
// their code should not sit in the main bundle every member downloads.
// `src/app/router.tsx` wraps `...adminRoutes`/`...operationsRoutes` in one
// shared `<Suspense>` boundary per area rather than one per page.
const AdminHomePage = lazy(() => import("@/pages/admin/AdminHomePage").then((m) => ({ default: m.AdminHomePage })));
const CarDetailPage = lazy(() => import("@/pages/admin/CarDetailPage").then((m) => ({ default: m.CarDetailPage })));
const CarsPage = lazy(() => import("@/pages/admin/CarsPage").then((m) => ({ default: m.CarsPage })));
const DepartmentsPage = lazy(() => import("@/pages/admin/DepartmentsPage").then((m) => ({ default: m.DepartmentsPage })));
const DestinationsPage = lazy(() => import("@/pages/admin/DestinationsPage").then((m) => ({ default: m.DestinationsPage })));
const IssuesPage = lazy(() => import("@/pages/admin/IssuesPage").then((m) => ({ default: m.IssuesPage })));
const MaintenancePage = lazy(() => import("@/pages/admin/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
const MembersPage = lazy(() => import("@/pages/admin/MembersPage").then((m) => ({ default: m.MembersPage })));
const PoliciesPage = lazy(() => import("@/pages/admin/PoliciesPage").then((m) => ({ default: m.PoliciesPage })));
const PolicyDetailPage = lazy(() => import("@/pages/admin/PolicyDetailPage").then((m) => ({ default: m.PolicyDetailPage })));
const RideTypesPage = lazy(() => import("@/pages/admin/RideTypesPage").then((m) => ({ default: m.RideTypesPage })));
const RosterPage = lazy(() => import("@/pages/admin/RosterPage").then((m) => ({ default: m.RosterPage })));
const SettingsPage = lazy(() => import("@/pages/admin/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const TemplatesPage = lazy(() => import("@/pages/admin/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));

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
