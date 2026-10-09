import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";

// REQ §13.116 (R8B8, R7U3): what the /p/<token> page shows each reader of a merge, and what an `external` offer's buttons mean.
// The edge function's summary is stubbed (`page.route`), so the spec needs no seeded merge - it checks the page's own
// rendering of the `merge` block that `proposal_viewer_merge` supplies (SQL: supabase/tests/p3_notices.sql).
const TOKEN = "stubbed-token";
const summary = (overrides: Record<string, unknown>) => ({
  proposalId: "00000000-0000-0000-0000-0000000000aa", type: "merge", status: "sent", reasonHe: "", expiresAt: null, payload: {},
  departmentId: "00000000-0000-0000-0000-000000000001", weekStart: "2030-01-06",
  request: { id: "r1", destination: "גן שמואל", rideType: null, departAt: "2030-01-07T08:45:00Z", returnAt: "2030-01-07T15:00:00Z", adults: 1, childSeats: 0, boosters: 0, tripType: "round_trip" },
  parties: [{ profileId: "p1", fullName: "נועה", response: "pending", isYou: true }],
  ...overrides,
});
const stub = async (page: import("@playwright/test").Page, body: unknown) =>
  page.route("**/functions/v1/answer-proposal**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));

test.describe("proposal page per reader", { tag: ["@proposals"] }, () => {
  test("the host sees the guest's one-way request, not 'your request' with a return", async ({ page }) => {
    await stub(page, summary({ merge: {
      role: "host", guestName: "נטע כהן", driverName: "נועה", leg: "out",
      rideStartsAt: "2030-01-07T09:00:00Z", rideEndsAt: "2030-01-07T12:00:00Z", newStartsAt: "2030-01-07T08:45:00Z", newEndsAt: "2030-01-07T12:00:00Z",
      guestDepartAt: "2030-01-07T08:45:00Z", guestReturnAt: null, ownDepartAt: "2030-01-07T08:45:00Z", ownReturnAt: null,
    } }));
    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByText(tv("proposalScreen.guestRequest", { name: "נטע כהן" }))).toBeVisible();
    await expect(page.getByText(he.proposalScreen.yourRequest, { exact: true })).toHaveCount(0);
    await expect(page.getByText(he.proposalScreen.rideBefore)).toBeVisible();
  });

  test("the guest sees their own request", async ({ page }) => {
    await stub(page, summary({ merge: {
      role: "guest", guestName: "נטע כהן", driverName: "נועה", leg: "both",
      rideStartsAt: "2030-01-07T09:00:00Z", rideEndsAt: "2030-01-07T16:00:00Z", newStartsAt: null, newEndsAt: null,
      guestDepartAt: "2030-01-07T09:00:00Z", guestReturnAt: "2030-01-07T15:00:00Z", ownDepartAt: "2030-01-07T08:45:00Z", ownReturnAt: "2030-01-07T15:00:00Z",
    } }));
    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByText(he.proposalScreen.yourRequest, { exact: true })).toBeVisible();
  });

  test("an external offer says what the two buttons do", async ({ page }) => {
    await stub(page, summary({ type: "external", merge: null, payload: { hint: "public_transport", reason: "x" } }));
    await page.goto(`/p/${TOKEN}`);
    await expect(page.getByRole("button", { name: he.proposalScreen.externalAccept })).toBeVisible();
    await expect(page.getByRole("button", { name: he.proposalScreen.externalStay })).toBeVisible();
  });
});
