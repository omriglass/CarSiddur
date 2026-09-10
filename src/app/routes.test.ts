import { matchPath } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { paths } from "./routes";

/**
 * Route *patterns* live once in `router.tsx`/`sadran/routes.tsx`/
 * `member/routes.tsx`; this only re-lists their pathnames (not elements) so
 * a builder that drifts from the real router fails here instead of at
 * runtime as a 404.
 */
const ROUTE_PATTERNS = [
  "/sadran",
  "/sadran/:dept/:week",
  "/sadran/:dept/:week/board",
  "/sadran/:dept/:week/proposals",
  "/sadran/:dept/:week/proposals/new",
  "/sadran/:dept/:week/claims",
  "/sadran/:dept/:week/claims/:offerId",
  "/sadran/:dept/:week/publish",
  "/sadran/:dept/:week/log",
  "/siddur",
  "/siddur/:dept",
  "/siddur/:dept/:week",
  "/siddur/:dept/archive",
  "/requests",
  "/requests/new",
  "/requests/:id/edit",
  "/inbox",
  "/p/:token",
  "/cars/:carId",
];

function pathnameOf(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

/** Asserts `url`'s pathname matches at least one registered route pattern. */
function expectRoutable(url: string) {
  const pathname = pathnameOf(url);
  const matched = ROUTE_PATTERNS.some((pattern) => matchPath(pattern, pathname) !== null);
  expect(matched, `${pathname} (from ${url}) did not match any registered route pattern`).toBe(true);
}

describe("paths.sadran", () => {
  it("board/week/proposals/composer/publish/claims/log all match registered patterns", () => {
    expectRoutable(paths.sadran.week("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.board("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.proposals("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.proposals("dept-1", "2027-01-10", "prop-1"));
    expectRoutable(paths.sadran.composer("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.publish("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.claims("dept-1", "2027-01-10"));
    expectRoutable(paths.sadran.claims("dept-1", "2027-01-10", "offer-1"));
    expectRoutable(paths.sadran.log("dept-1", "2027-01-10"));
  });

  it("proposals() appends ?proposal= only when an id is given", () => {
    expect(paths.sadran.proposals("d", "2027-01-10")).toBe("/sadran/d/2027-01-10/proposals");
    expect(paths.sadran.proposals("d", "2027-01-10", "p1")).toBe("/sadran/d/2027-01-10/proposals?proposal=p1");
  });
});

describe("paths.siddur", () => {
  it("bare, dept-only and dept+week forms all match registered patterns", () => {
    expectRoutable(paths.siddur());
    expectRoutable(paths.siddur({ dept: "dept-1" }));
    expectRoutable(paths.siddur({ dept: "dept-1", week: "2027-01-10" }));
    expectRoutable(paths.siddur({ rideId: "ride-1" }));
    expectRoutable(paths.siddur({ dept: "dept-1", week: "2027-01-10", rideId: "ride-1" }));
  });

  it("week is ignored without dept (there is no bare /siddur/:week route)", () => {
    expect(paths.siddur({ week: "2027-01-10" })).toBe("/siddur");
  });

  it("appends ?ride= when rideId is given", () => {
    expect(paths.siddur({ dept: "d", rideId: "r1" })).toBe("/siddur/d?ride=r1");
  });

  it("appends ?day=&group= for a contested waiting-list group deep link (REQ §13.75)", () => {
    expectRoutable(paths.siddur({ dept: "dept-1", week: "2027-01-10", day: "2027-01-12", groupId: "group-1" }));
    expect(paths.siddur({ dept: "d", week: "w", day: "2027-01-12", groupId: "group-1" })).toBe("/siddur/d/w?day=2027-01-12&group=group-1");
  });
});

describe("paths.siddurArchive", () => {
  it("matches /siddur/:dept/archive", () => {
    expectRoutable(paths.siddurArchive("dept-1"));
    expect(paths.siddurArchive("dept-1")).toBe("/siddur/dept-1/archive");
  });
});

describe("paths.requests", () => {
  it("list/new/edit all match registered patterns", () => {
    expectRoutable(paths.requests.list());
    expectRoutable(paths.requests.list("req-1"));
    expectRoutable(paths.requests.new());
    expectRoutable(paths.requests.new({ ride: "ride-1" }));
    expectRoutable(paths.requests.new({ week: "2027-01-10", day: "2027-01-12", time: "08:00" }));
    expectRoutable(paths.requests.new({ template: "template-1" }));
    expectRoutable(paths.requests.edit("req-1"));
  });

  it("new() builds the expected query string", () => {
    expect(paths.requests.new({ week: "2027-01-10", day: "2027-01-12", time: "08:00" })).toBe(
      "/requests/new?week=2027-01-10&day=2027-01-12&time=08%3A00",
    );
    expect(paths.requests.new({ ride: "ride-1" })).toBe("/requests/new?ride=ride-1");
    expect(paths.requests.new({ week: "2027-01-10", day: "2027-01-12", waitlist: true })).toBe(
      "/requests/new?week=2027-01-10&day=2027-01-12&waitlist=1",
    );
    expect(paths.requests.new({ template: "template-1" })).toBe("/requests/new?template=template-1");
  });
});

describe("paths.proposalToken", () => {
  it("matches /p/:token", () => {
    expectRoutable(paths.proposalToken("secret-token"));
  });
});

describe("paths.inbox", () => {
  it("matches /inbox with and without ?change=", () => {
    expectRoutable(paths.inbox());
    expectRoutable(paths.inbox("change-1"));
    expect(paths.inbox("change-1")).toBe("/inbox?change=change-1");
  });
});

describe("paths.car", () => {
  it("matches /cars/:carId", () => {
    expectRoutable(paths.car("car-1"));
    expect(paths.car("car-1")).toBe("/cars/car-1");
  });
});
