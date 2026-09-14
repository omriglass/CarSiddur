import { lazy } from "react";

/**
 * Member pages that are not the landing screen load lazily (owner,
 * 2026-09-14: the eager bundle sat at the 500 kB warning limit). Home,
 * login, pending, onboarding and 404 stay eager — they are the first paint.
 * Same `React.lazy()` shape as sadran/admin routes.
 *
 * Kept out of `router.tsx` itself: react-refresh's `only-export-components`
 * rule flags any top-level `lazy(...)`-wrapped binding in a file whose only
 * export (`router`) is not itself a component — moving them to their own
 * module (a non-component file, lint-exempt) clears the warning without
 * changing behavior (eslint.config.js react-refresh cleanup, 2026-09-14).
 */
export const SiddurPage = lazy(() => import("@/pages/SiddurPage").then((m) => ({ default: m.SiddurPage })));
export const NewRequestPage = lazy(() => import("@/pages/NewRequestPage").then((m) => ({ default: m.NewRequestPage })));
export const InboxPage = lazy(() => import("@/pages/InboxPage").then((m) => ({ default: m.InboxPage })));
export const ProfilePage = lazy(() => import("@/pages/ProfilePage").then((m) => ({ default: m.ProfilePage })));
export const ProposalTokenPage = lazy(() => import("@/pages/ProposalTokenPage").then((m) => ({ default: m.ProposalTokenPage })));
