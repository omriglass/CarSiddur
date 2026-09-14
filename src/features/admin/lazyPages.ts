import { lazy } from "react";

/**
 * Lazily loaded (docs/HARDENING_2026-09.md §3 item 2): the admin/operations
 * screens are a heavy area only admins/operations managers ever reach, so
 * their code should not sit in the main bundle every member downloads.
 *
 * Kept out of `routes.tsx` itself: react-refresh's `only-export-components`
 * rule flags any top-level `lazy(...)`-wrapped binding in a file whose only
 * *exports* are plain data (the `RouteObject[]` arrays), even though these
 * bindings are never exported themselves — moving them to their own module
 * (a non-component file, lint-exempt) clears the warning without changing
 * behavior (eslint.config.js react-refresh cleanup, 2026-09-14).
 */
export const AdminHomePage = lazy(() => import("@/pages/admin/AdminHomePage").then((m) => ({ default: m.AdminHomePage })));
export const CarDetailPage = lazy(() => import("@/pages/admin/CarDetailPage").then((m) => ({ default: m.CarDetailPage })));
export const CarsPage = lazy(() => import("@/pages/admin/CarsPage").then((m) => ({ default: m.CarsPage })));
export const DepartmentsPage = lazy(() => import("@/pages/admin/DepartmentsPage").then((m) => ({ default: m.DepartmentsPage })));
export const DestinationsPage = lazy(() => import("@/pages/admin/DestinationsPage").then((m) => ({ default: m.DestinationsPage })));
export const IssuesPage = lazy(() => import("@/pages/admin/IssuesPage").then((m) => ({ default: m.IssuesPage })));
export const MaintenancePage = lazy(() => import("@/pages/admin/MaintenancePage").then((m) => ({ default: m.MaintenancePage })));
export const MembersPage = lazy(() => import("@/pages/admin/MembersPage").then((m) => ({ default: m.MembersPage })));
export const PoliciesPage = lazy(() => import("@/pages/admin/PoliciesPage").then((m) => ({ default: m.PoliciesPage })));
export const PolicyDetailPage = lazy(() => import("@/pages/admin/PolicyDetailPage").then((m) => ({ default: m.PolicyDetailPage })));
export const RideTypesPage = lazy(() => import("@/pages/admin/RideTypesPage").then((m) => ({ default: m.RideTypesPage })));
export const RosterPage = lazy(() => import("@/pages/admin/RosterPage").then((m) => ({ default: m.RosterPage })));
export const SettingsPage = lazy(() => import("@/pages/admin/SettingsPage").then((m) => ({ default: m.SettingsPage })));
export const TemplatesPage = lazy(() => import("@/pages/admin/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
