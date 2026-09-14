import { lazy } from "react";

/**
 * Lazily loaded (docs/HARDENING_2026-09.md §3 item 2): the board and its
 * surrounding Sadran screens are a heavy area only a coordinator ever
 * reaches, so their code should not sit in the main bundle every member
 * downloads.
 *
 * Kept out of `routes.tsx` itself: react-refresh's `only-export-components`
 * rule flags any top-level `lazy(...)`-wrapped binding in a file whose only
 * *exports* are plain data (the `RouteObject[]` array), even though these
 * bindings are never exported themselves — moving them to their own module
 * (a non-component file, lint-exempt) clears the warning without changing
 * behavior (eslint.config.js react-refresh cleanup, 2026-09-14).
 */
export const SadranIndexPage = lazy(() => import("@/pages/sadran/SadranIndexPage").then((m) => ({ default: m.SadranIndexPage })));
export const WeekDashboardPage = lazy(() => import("@/pages/sadran/WeekDashboardPage").then((m) => ({ default: m.WeekDashboardPage })));
export const BoardPage = lazy(() => import("@/pages/sadran/BoardPage").then((m) => ({ default: m.BoardPage })));
export const ProposalsListPage = lazy(() => import("@/pages/sadran/ProposalsListPage").then((m) => ({ default: m.ProposalsListPage })));
export const ProposalComposerPage = lazy(() => import("@/pages/sadran/ProposalComposerPage").then((m) => ({ default: m.ProposalComposerPage })));
export const ClaimsPage = lazy(() => import("@/pages/sadran/ClaimsPage").then((m) => ({ default: m.ClaimsPage })));
export const PublishPage = lazy(() => import("@/pages/sadran/PublishPage").then((m) => ({ default: m.PublishPage })));
export const LogPage = lazy(() => import("@/pages/sadran/LogPage").then((m) => ({ default: m.LogPage })));
