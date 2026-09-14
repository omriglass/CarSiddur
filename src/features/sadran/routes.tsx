import type { RouteObject } from "react-router-dom";

import {
  SadranIndexPage,
  WeekDashboardPage,
  BoardPage,
  ProposalsListPage,
  ProposalComposerPage,
  ClaimsPage,
  PublishPage,
  LogPage,
} from "./lazyPages";

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
