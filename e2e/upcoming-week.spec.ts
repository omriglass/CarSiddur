import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import {
  getWeekStart,
  NEVO_DEPARTMENT_ID,
  newSignedInPage,
  SEEDED_USERS,
  serviceRoleClient,
  signIn,
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
} from "./helpers";
import { paths } from "../src/app/routes";

// The `upcoming` week phase (REQ §13.77, consistency additions 2026-09-10): a multi-day series
// reaching a week the department hasn't opened yet materializes it early via
// `ensure_upcoming_week()` instead of failing — that week phase is `upcoming`, not `open`, so
// members can't file ordinary new requests into it yet, but the Sadran board can already see
// and manage it ahead of time.
const DESTINATION = "E2E upcoming-week destination";

test.describe("upcoming week phase", () => {
  test("a series reaching two weeks out materializes an upcoming week, hidden from members but visible to the Sadran", async ({ page, browser }) => {
    const service = serviceRoleClient();
    const openWeekStart = await getWeekStart("open");
    const farWeekStart = new Date(Date.parse(`${openWeekStart}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const farDay0 = farWeekStart;
    const farDay1 = new Date(Date.parse(`${farWeekStart}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
    await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", farWeekStart);

    try {
      // Submitted as the member themself — `submit_request`'s own-request path needs no
      // `can_manage_week()` elevation (matching a real member filing their own series).
      const memberClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      const { error: authError } = await memberClient.auth.signInWithPassword(SEEDED_USERS.member1);
      if (authError) throw authError;
      const { error: submitError } = await memberClient.rpc("submit_series_request", {
        payload: {
          department_id: NEVO_DEPARTMENT_ID, ride_type_id: "00000000-0000-0000-0000-000000000021",
          destination_text: DESTINATION, trip_shape: "round_trip", adults: 1,
          depart_at: `${farDay0}T08:00:00+02:00`, return_at: `${farDay1}T10:00:00+02:00`,
        },
      });
      if (submitError) throw submitError;

      const { data: week } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", farWeekStart).single();
      expect(week?.phase).toBe("upcoming");

      // The member's Home/new-request week picker never offers it: overriding `?week=` to the
      // upcoming week is silently ignored by `resolveWeekStart`, which falls back to a real
      // open week instead.
      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.new({ week: farWeekStart }));
      await expect(page.getByText("בקשה חדשה")).toBeVisible();
      const subtitle = page.locator("main p").first();
      await expect(subtitle).toBeVisible();
      await expect(subtitle).not.toContainText(farWeekStart.slice(8, 10));

      // The Sadran board switcher lists it with the "טרם נפתח" badge — a *separate* browser
      // context (helpers.ts: reusing one `page` across two `signIn()` calls for different
      // users is unreliable, since `/login` redirects away immediately once a session exists).
      const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
      try {
        // `board-title-switcher` is the mobile-only header title (the `lg+` board uses a
        // separate inline `BoardWeekSwitcher` instead) — without a phone viewport it's
        // `display:none`, so the click below waits forever for it to become visible.
        await sadran.page.setViewportSize({ width: 390, height: 844 });
        await sadran.page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));
        await sadran.page.getByTestId("board-title-switcher").click();
        const option = sadran.page.getByTestId(`board-week-option-${farWeekStart}`);
        await expect(option).toBeVisible();
        await expect(option.getByText(he.phase.upcoming, { exact: true })).toBeVisible();
      } finally {
        await sadran.context.close();
      }
    } finally {
      await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
      await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", farWeekStart);
    }
  });
});
