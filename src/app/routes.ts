/**
 * Single source of truth for building app URLs. `src/app/router.tsx` (plus
 * `src/features/sadran/routes.tsx` / `src/features/member/routes.tsx`) is the
 * single source of truth for the route *patterns*; every builder here must
 * produce a pathname that matches one of those patterns exactly (enforced by
 * `routes.test.ts` via react-router's `matchPath`). Hand-built template
 * strings (`` `/sadran/${dept}/${week}/board` ``, `` `/requests/new?ride=${id}` ``,
 * …) are forbidden outside this file — see REFACTOR_BACKLOG.md §6.
 */

/** Appends only the query params that are actually present. */
function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

export const paths = {
  sadran: {
    /** `/sadran/:dept/:week` — redirects straight to `.board()`; kept mainly as a `returnTo` safelist entry (`ProposalComposerScreen`). */
    week: (departmentId: string, weekStart: string) => `/sadran/${departmentId}/${weekStart}`,
    board: (departmentId: string, weekStart: string) => `/sadran/${departmentId}/${weekStart}/board`,
    /** `?proposal=<id>` highlights and scrolls to that row (`ProposalsListScreen`). */
    proposals: (departmentId: string, weekStart: string, proposalId?: string) =>
      withQuery(`/sadran/${departmentId}/${weekStart}/proposals`, { proposal: proposalId }),
    composer: (departmentId: string, weekStart: string) => `/sadran/${departmentId}/${weekStart}/proposals/new`,
    publish: (departmentId: string, weekStart: string) => `/sadran/${departmentId}/${weekStart}/publish`,
    claims: (departmentId: string, weekStart: string, offerId?: string) =>
      offerId ? `/sadran/${departmentId}/${weekStart}/claims/${offerId}` : `/sadran/${departmentId}/${weekStart}/claims`,
    log: (departmentId: string, weekStart: string) => `/sadran/${departmentId}/${weekStart}/log`,
  },

  /**
   * `/siddur` | `/siddur/:dept` | `/siddur/:dept/:week` (`src/features/member/routes.tsx`).
   * `rideId` maps to the `?ride=` query param `SiddurPage` reads to open/focus
   * a specific ride's detail sheet on load; `day`/`groupId` map to
   * `?day=<day>&group=<id>` (`notification_default_url()`'s waitlist-group
   * deep link, REQ §13.75) which opens that day with the contested
   * waiting-list group's resolution sheet already open; `week` is only
   * meaningful once `dept` is also given (there is no bare `/siddur/:week`
   * route).
   */
  siddur: (opts: { dept?: string; week?: string; rideId?: string; day?: string; groupId?: string } = {}): string => {
    const { dept, week, rideId, day, groupId } = opts;
    let path = "/siddur";
    if (dept) path += `/${dept}`;
    if (dept && week) path += `/${week}`;
    return withQuery(path, { ride: rideId, day, group: groupId });
  },

  /**
   * `/siddur/:dept/archive` — read-only list of past siddurim (Archive of past
   * siddurim, owner decision 2026-09-10): past weeks disappear from the
   * regular week switcher/strip and live only here.
   */
  siddurArchive: (departmentId: string): string => `/siddur/${departmentId}/archive`,

  requests: {
    /**
     * `/requests`. `focusId` is accepted for forward compatibility with a
     * `?focus=<requestId>` deep link — `RequestsListPage` does not read it
     * yet (see `InboxPage.tsx`'s `deepLinkFor` comment); passing it today is
     * a harmless no-op until that screen adds the param.
     */
    list: (focusId?: string) => withQuery("/requests", { focus: focusId }),
    /**
     * `/requests/new`; `ride` triggers the "ask to join" prefill, `day`/`time` the
     * quick-request-from-slot prefill, `template` the repeating-request-suggestion prefill
     * (`v_request_template_suggestions`, all mutually exclusive in practice), `waitlist=1` the
     * waitlist checkbox.
     */
    new: (params: { ride?: string; week?: string; day?: string; time?: string; waitlist?: boolean; template?: string } = {}) =>
      withQuery("/requests/new", {
        ride: params.ride,
        week: params.week,
        day: params.day,
        time: params.time,
        waitlist: params.waitlist ? "1" : undefined,
        template: params.template,
      }),
    edit: (requestId: string) => `/requests/${requestId}/edit`,
  },

  /** `/p/:token` — no-sign-in-required proposal answering (ARCHITECTURE.md §8). */
  proposalToken: (token: string) => `/p/${token}`,

  /**
   * `/cars/:carId` — car page (car care portal, REQUIREMENTS §6.6,
   * UX_FLOWS.md §5.11). `notification_default_url()`'s `car_care` deep-link
   * target; also linked from the admin cars list's car-name cell.
   */
  car: (carId: string) => `/cars/${carId}`,

  /** `/inbox`; `?change=<rideChangeId>` is produced by `deepLinkFor` for `ride_change_id` notifications. */
  inbox: (changeId?: string) => withQuery("/inbox", { change: changeId }),
};
