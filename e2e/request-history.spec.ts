import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * REQ §13.204 (b–d), owner 2026-11-09 (production: requests that "disappeared without a trace"): a withdrawn request
 * stays visible to its member under its week on /my ("בקשות שנסגרו") with "מה קרה?", and the Sadran's change-log
 * name search lists it with its whole story.
 */
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-03-03"; // a Sunday
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";

type Service = ReturnType<typeof serviceRoleClient>;

async function cleanup(service: Service) {
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

test.describe("request history", { tag: ["@request-history"] }, () => {
  let service: Service;
  let requestId: string;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    const admin = await publishedFixtureWeek(WEEK);
    await admin.auth.signOut();
    await cleanup(service);
    const { data, error } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: MEMBER1_ID, filed_by: MEMBER1_ID,
      ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: "E2E history",
      trip_shape: "round_trip", depart_at: "2041-03-04T09:00:00+02:00", return_at: "2041-03-04T12:00:00+02:00",
      status: "waitlisted", status_reason: "WAITLISTED_NO_CAR",
    }).select("id").single();
    if (error) throw error;
    requestId = data!.id;
    const { error: withdrawError } = await service.from("requests").update({ status: "withdrawn", status_reason: "WITHDRAWN_BY_MEMBER" }).eq("id", requestId);
    if (withdrawError) throw withdrawError;
  });

  test.afterEach(async () => {
    await cleanup(service);
  });

  test("a member sees the withdrawn request under its week and what happened", async ({ browser }) => {
    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await page.goto("/my");
      const closed = page.locator(`[data-week-start="${WEEK}"]`).getByTestId("my-week-closed");
      await closed.getByText(tv("requestHistory.closedInWeek", { count: "1" })).click();
      const row = closed.locator(`[data-closed-request="${requestId}"]`);
      await expect(row).toContainText("E2E history");
      await expect(row).toContainText(he.statusReason.WITHDRAWN_BY_MEMBER);
      await row.getByTestId("closed-request-history").click();
      const dialog = page.getByTestId("request-history-dialog");
      await expect(dialog.getByTestId("request-timeline-line").first()).toContainText(he.requestHistory.filed.split(":")[0] ?? "");
      await expect(dialog).toContainText(tv("requestHistory.status", { status: he.status.withdrawn }));
    } finally {
      await context.close();
    }
  });

  test("the Sadran's name search lists it with its story", async ({ browser }) => {
    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/log`);
      await page.getByRole("searchbox", { name: he.sadranLog.searchPlaceholder }).fill(SEEDED_USERS.member1.fullName);
      await expect(page.getByTestId("change-log-search-all")).toBeVisible();
      const row = page.locator(`[data-change-log-request="${requestId}"]:visible`);
      await expect(row).toContainText(he.status.withdrawn);
      await row.getByTestId("change-log-history").locator("summary").click();
      await expect(row.getByTestId("request-timeline-line")).toHaveCount(2);
    } finally {
      await context.close();
    }
  });
});
