import { lazy } from "react";
import type { RouteObject } from "react-router-dom";

// Lazily loaded (docs/HARDENING_2026-09.md §3 item 2): the board and its
// surrounding Sadran screens are a heavy area only a coordinator ever
// reaches, so their code should not sit in the main bundle every member
// downloads. `src/app/router.tsx` wraps `...sadranRoutes` in one shared
// `<Suspense>` boundary rather than one per page.
const SadranIndexPage = lazy(() => import("@/pages/sadran/SadranIndexPage").then((m) => ({ default: m.SadranIndexPage })));
const WeekDashboardPage = lazy(() => import("@/pages/sadran/WeekDashboardPage").then((m) => ({ default: m.WeekDashboardPage })));
const BoardPage = lazy(() => import("@/pages/sadran/BoardPage").then((m) => ({ default: m.BoardPage })));
const ProposalsListPage = lazy(() => import("@/pages/sadran/ProposalsListPage").then((m) => ({ default: m.ProposalsListPage })));
const ProposalComposerPage = lazy(() => import("@/pages/sadran/ProposalComposerPage").then((m) => ({ default: m.ProposalComposerPage })));
const ClaimsPage = lazy(() => import("@/pages/sadran/ClaimsPage").then((m) => ({ default: m.ClaimsPage })));
const PublishPage = lazy(() => import("@/pages/sadran/PublishPage").then((m) => ({ default: m.PublishPage })));
const LogPage = lazy(() => import("@/pages/sadran/LogPage").then((m) => ({ default: m.LogPage })));

/**
 * Sadran route list (stage 2b, UX_FLOWS.md §4), spread as `...sadranRoutes`
 * into `src/app/router.tsx` under the existing `RequireSadran` element — same
 * one-line-diff reasoning as `adminRoutes`/`memberRoutes` (UX_FLOWS.md §13
 * note 10, §14). Fully replaces the bare `{ path: "/sadran", element:
 * <SadranPage /> }` placeholder entry (and that placeholder page, deleted).
 */
export const sadranRoutes: RouteObject[] = [
  { path: "/sadran", element: <SadranIndexPage /> },
  { path: "/sadran/:dept/:week", element: <WeekDashboardPage /> },
  { path: "/sadran/:dept/:week/board", element: <BoardPage /> },
  { path: "/sadran/:dept/:week/proposals", element: <ProposalsListPage /> },
  { path: "/sadran/:dept/:week/proposals/new", element: <ProposalComposerPage /> },
  { path: "/sadran/:dept/:week/claims", element: <ClaimsPage /> },
  { path: "/sadran/:dept/:week/claims/:offerId", element: <ClaimsPage /> },
  { path: "/sadran/:dept/:week/publish", element: <PublishPage /> },
  { path: "/sadran/:dept/:week/log", element: <LogPage /> },
];
