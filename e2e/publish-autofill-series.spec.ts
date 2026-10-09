import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL } from "./helpers";
import { dayOfWeek, ensureUnpublishedWeek, insertRequest, PLACES, PROFILE_IDS, removeWeek, winterAt } from "./request-form";

// Pilot fix round P1 (REQ §13.115, docs/PILOT_FIX_ROUND_2026-10.md):
//  R8B1 - per-day autofill on the LAST day of a Monday-Thursday series places the whole series (every day), not only that day.
//  R8B2 - the publish day picker pre-ticks only days somebody solved: a day whose request is still "submitted" is not ready,
//         is not pre-ticked and reads "N requests not solved yet".
const WEEK = "2045-03-05"; // a Sunday, far from the other fixture weeks
const MONDAY = dayOfWeek(WEEK, 1);
const THURSDAY = dayOfWeek(WEEK, 4);
const FRIDAY = dayOfWeek(WEEK, 5);

test.describe.serial("per-day autofill places a series; the publish picker ticks only solved days", { tag: ["@board", "@publication"] }, () => {
  const service = serviceRoleClient();
  let seriesId = "";

  test.beforeAll(async () => {
    await ensureUnpublishedWeek(service, WEEK, "open");
    const sadranClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: authError } = await sadranClient.auth.signInWithPassword(SEEDED_USERS.sadran);
    if (authError) throw authError;
    const { data, error } = await sadranClient.rpc("submit_series_request", {
      payload: {
        department_id: NEVO_DEPARTMENT_ID, requester_id: PROFILE_IDS.member1, ride_type_id: "00000000-0000-0000-0000-000000000021",
        destination_text: "E2E series autofill", trip_shape: "round_trip", adults: 1,
        depart_at: winterAt(MONDAY, "08:00"), return_at: winterAt(THURSDAY, "17:00"),
      },
    });
    if (error) throw error;
    seriesId = (data as { series_id: string }).series_id;
    // Friday: one ordinary request nobody solves.
    await insertRequest(service, FRIDAY, { week: WEEK, requester: PROFILE_IDS.member2, depart: "09:00", return: "12:00", destinationId: PLACES.jerusalem.id });
  });

  test.afterAll(async () => {
    await service.from("requests").delete().eq("series_id", seriesId);
    await removeWeek(service, WEEK);
  });

  test("autofill on Thursday places all four days of the series (R8B1)", async ({ browser }) => {
    const { page, context } = await newSignedInPage(browser, SEEDED_USERS.sadran);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, WEEK));
    const applied = page.waitForResponse((response) => response.url().endsWith("/rest/v1/rpc/apply_solver_result") && response.request().method() === "POST");
    await page.getByRole("button", { name: he.sadranBoard.actionsMenu, exact: true }).click();
    await page.getByRole("menuitem", { name: he.action.autoSolveRemaining, exact: true }).click();
    await page.getByTestId(`autofill-day-${THURSDAY}`).click();
    await page.getByRole("alertdialog").or(page.getByRole("dialog")).getByRole("button", { name: he.sadranBoard.autoFill.confirmAction, exact: true }).click();
    const appliedRes = await applied;
    expect(appliedRes.ok(), await appliedRes.text()).toBe(true);

    const { data: legs, error } = await service.from("requests").select("status, status_reason").eq("series_id", seriesId);
    if (error) throw error;
    expect(legs).toHaveLength(4);
    expect(legs!.every((leg) => leg.status === "assigned"), JSON.stringify(legs)).toBe(true);
    const { data: rides } = await service.from("rides").select("car_id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).neq("status", "cancelled");
    expect(new Set((rides ?? []).map((ride) => ride.car_id)).size).toBe(1);
    await context.close();
  });

  test("the publish picker does not pre-tick the day nobody solved (R8B2)", async ({ browser }) => {
    const { page, context } = await newSignedInPage(browser, SEEDED_USERS.sadran);
    await page.goto(paths.sadran.publish(NEVO_DEPARTMENT_ID, WEEK));
    await page.getByRole("button", { name: he.publicationFlow.selectDays, exact: true }).click();
    await expect(page.getByText(he.publicationFlow.unsolvedOne)).toBeVisible();
    // Seven days, Friday is the only one not ready.
    await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(6);
    await context.close();
  });
});
