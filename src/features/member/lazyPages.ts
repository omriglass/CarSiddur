import { lazy } from "react";

/**
 * Every member page loads lazily (owner, 2026-09-14: the eager bundle sat at
 * Vite's 500 kB warning limit); same `React.lazy()` shape as the
 * sadran/admin route files.
 *
 * Kept out of `routes.tsx` itself: react-refresh's `only-export-components`
 * rule flags any top-level `lazy(...)`-wrapped binding in a file whose only
 * export is plain data (the `RouteObject[]` array), even though these
 * bindings are never exported themselves — moving them to their own module
 * (a non-component file, lint-exempt) clears the warning without changing
 * behavior (eslint.config.js react-refresh cleanup, 2026-09-14).
 */
export const CarPage = lazy(() => import("@/pages/CarPage").then((m) => ({ default: m.CarPage })));
export const EditRequestPage = lazy(() => import("@/pages/EditRequestPage").then((m) => ({ default: m.EditRequestPage })));
export const RequestsListPage = lazy(() => import("@/pages/RequestsListPage").then((m) => ({ default: m.RequestsListPage })));
export const SiddurArchivePage = lazy(() => import("@/pages/SiddurArchivePage").then((m) => ({ default: m.SiddurArchivePage })));
export const SiddurPage = lazy(() => import("@/pages/SiddurPage").then((m) => ({ default: m.SiddurPage })));
export const StatsPage = lazy(() => import("@/pages/StatsPage").then((m) => ({ default: m.StatsPage })));
