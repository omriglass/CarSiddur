import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";
import { he, t, tv } from "../src/i18n/he";
import { formatDayDate } from "../src/lib/dayLabels";
import { getWeekStart, NEVO_DEPARTMENT_ID, openRideDetails, SEEDED_USERS, serviceRoleClient, signIn, SUPABASE_ANON_KEY, SUPABASE_URL, submitRequestForm } from "./helpers";

// Multi-day ("series") requests (REQ §13.77, UX_FLOWS §3.3/§3.4, built 2026-09-10): a round
// trip whose return is a later calendar day files one `submit_request` per day, all sharing
// one `series_id` — the member sees exactly one card (with a "{{count}} ימים" badge); the
// Sadran's board shows each leg with a "יום {{index}}/{{count}}" marker once placed.
const DESTINATION = "E2E multi-day destination";
const MEMBER_ID = "00000000-0000-0000-0000-000000000103";
const TZ = "Asia/Jerusalem";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("multi-day requests", { tag: ["@request-form"] }, () => {
  test("submitting a 3-day series shows one card, three linked legs, and cascading withdraw", async ({ page }) => {
    const service = serviceRoleClient();
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);

    await signIn(page, SEEDED_USERS.member1);
    await page.goto("/requests/new");
    await expect(page.getByText("בקשה חדשה")).toBeVisible();
    await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
    await page.getByPlaceholder("לאן?").fill(DESTINATION);
    await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();
    await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();

    await page.getByRole("button", { name: t("request.returnAnotherDay"), exact: true }).click();
    const returnPicker = page.getByRole("radiogroup", { name: t("request.returnDay") });
    await expect(returnPicker).toBeVisible();
    // The return-day `DateField` offers the days after the departure (index 0 = the next day; the
    // departure's own week before it is greyed, not a radio); index 1 is a 3-day span (REQ §13.77).
    await returnPicker.getByRole("radio").nth(1).click();
    await expect(page.getByText(tv("request.multiDayBadge", { count: "3" }))).toBeVisible();

    await submitRequestForm(page);
    // Post-submit navigates to `/my` (2026-09-16, REQ §13 item 91) instead of the old
    // `/requests` list.
    await expect(page).toHaveURL(/\/my$/);

    const { data: legs, error } = await service.from("requests").select("id, series_id, series_index, series_count, depart_at, return_at")
      .eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION).order("series_index", { ascending: true });
    if (error) throw error;
    expect(legs?.length).toBe(3);
    const [leg1, leg2, leg3] = legs!;
    const seriesId = leg1!.series_id;
    expect(seriesId).toBeTruthy();
    expect(legs!.every((leg) => leg.series_id === seriesId)).toBe(true);
    expect(legs!.map((leg) => leg.series_index)).toEqual([1, 2, 3]);
    expect(legs!.every((leg) => leg.series_count === 3)).toBe(true);
    // Boundary windows, in Asia/Jerusalem local time (never raw UTC — CLAUDE.md hard rule 6):
    // leg 1 ends 23:59, legs 2/3 both start at local midnight.
    const localTime = (iso: string) => formatInTimeZone(new Date(iso), TZ, "HH:mm:ss");
    expect(localTime(leg1!.return_at)).toBe("23:59:00");
    expect(localTime(leg2!.depart_at)).toBe("00:00:00");
    expect(localTime(leg2!.return_at)).toBe("23:59:00");
    expect(localTime(leg3!.depart_at)).toBe("00:00:00");

    // Exactly one card on /my, badged "3 ימים".
    const card = page.locator("[data-request-id]").filter({ hasText: DESTINATION });
    await expect(card).toHaveCount(1);
    await expect(card.getByText(tv("request.multiDayBadge", { count: "3" }))).toBeVisible();

    // Withdrawing the card cascades to every leg.
    await card.getByRole("button", { name: he.requestsList.cancel, exact: true }).click();
    await expect(page.getByRole("heading", { name: he.request.withdrawConfirmTitle })).toBeVisible();
    await page.getByRole("button", { name: he.requestsList.withdraw, exact: true }).last().click();
    await expect(page.getByText(DESTINATION)).toHaveCount(0);

    const { data: afterWithdraw } = await service.from("requests").select("status").eq("series_id", seriesId);
    expect(afterWithdraw!.every((leg) => leg.status === "withdrawn")).toBe(true);
  });

  test("Sadran board shows placed series legs with a day marker on consecutive days", async ({ page }) => {
    const service = serviceRoleClient();
    const openWeekStart = await getWeekStart("open");
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);

    const { data: sharedCar } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1).single();
    const day0 = openWeekStart;
    const day1 = new Date(Date.parse(`${openWeekStart}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const day2 = new Date(Date.parse(`${openWeekStart}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);

    // `submit_request`/`place_series` require an authenticated actor: filing on someone else's
    // behalf (as here) needs `can_manage_week()`, which a bare service-role call (no session,
    // `auth.uid()` null) never satisfies — sign in as the standing Sadran instead.
    const sadranClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: authError } = await sadranClient.auth.signInWithPassword(SEEDED_USERS.sadran);
    if (authError) throw authError;

    const { data: submitResult, error: submitError } = await sadranClient.rpc("submit_series_request", {
      payload: {
        department_id: NEVO_DEPARTMENT_ID, requester_id: MEMBER_ID, ride_type_id: "00000000-0000-0000-0000-000000000021",
        destination_text: DESTINATION, trip_shape: "round_trip", adults: 1,
        depart_at: `${day0}T08:00:00+02:00`, return_at: `${day2}T10:00:00+02:00`,
      },
    });
    if (submitError) throw submitError;
    const seriesId = (submitResult as { series_id: string }).series_id;

    // `place_series` has EXECUTE revoked from `public`/`anon`/`authenticated` entirely (it's
    // meant to be called only from other `SECURITY DEFINER` functions) — only the service role
    // can invoke it directly, exactly as this fixture needs to (docs/UX_FLOWS.md predates this
    // restriction; noted for db-migrator/docs-keeper).
    const { error: placeError } = await service.rpc("place_series", { p_series_id: seriesId, p_car_id: sharedCar!.id });
    if (placeError) throw placeError;

    // The board's car columns overflow a phone width — a wide viewport keeps the placed car's
    // column (and its series-day marker) on-screen without needing horizontal scroll handling.
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, SEEDED_USERS.sadran);
    for (const [day, expectedMarker] of [[day0, "יום 1/3"], [day1, "יום 2/3"], [day2, "יום 3/3"]] as const) {
      await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${openWeekStart}/board`);
      const dayIndex = Number(new Date(`${day}T12:00:00Z`).getUTCDay());
      await page.getByRole("radio").nth(dayIndex).click();
      await expect(page.getByText(expectedMarker, { exact: true })).toBeVisible();
      // R20H2: every day's ride sheet offers "פיצול", not only the first day's.
      await page.getByText(expectedMarker, { exact: true }).click();
      await page.getByRole("button", { name: "פרטי הנסיעה" }).click();
      await page.getByRole("tab", { name: "פעולות" }).click();
      await expect(page.getByTestId("ride-sheet-split")).toBeVisible();
    }

    // R20H1: the Sadran cancels the middle day only; the other two days keep the car.
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${openWeekStart}/board`);
    await page.getByRole("radio").nth(Number(new Date(`${day1}T12:00:00Z`).getUTCDay())).click();
    await page.getByText("יום 2/3", { exact: true }).click();
    await page.getByRole("button", { name: "פרטי הנסיעה" }).click();
    await page.getByRole("tab", { name: "פעולות" }).click();
    await page.getByTestId("ride-sheet-cancel").click();
    await expect(page.getByTestId("ride-cancel-only-day")).toHaveAttribute("data-state", "checked");
    await page.getByRole("dialog", { name: he.request.seriesCancelTitle }).getByRole("button", { name: he.closeRequest.cancelConfirm, exact: true }).click();
    await expect.poll(async () => {
      const { data } = await service.from("requests").select("status, series_id").eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION).order("depart_at");
      return (data ?? []).map((row) => `${row.status === "assigned" ? "placed" : "not placed"}:${row.series_id ? "series" : "single"}`).join(",");
    }).toBe("placed:single,not placed:single,placed:single");
    const { data: kept } = await service.from("rides").select("id").eq("car_id", sharedCar!.id).neq("status", "cancelled")
      .gte("starts_at", `${day0}T00:00:00Z`).lt("starts_at", `${day2}T23:59:59Z`);
    expect(kept?.length).toBe(2);

    await service.from("requests").delete().eq("series_id", seriesId);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", openWeekStart).eq("car_id", sharedCar!.id).gte("starts_at", `${day0}T00:00:00Z`).lt("starts_at", `${day2}T23:59:59Z`);
  });

  test("R20H1: the driver cancels only one day of a two-day ride from the siddur; the other day keeps the car", async ({ page }) => {
    const service = serviceRoleClient();
    const liveWeekStart = await getWeekStart("live");
    const dayKey = (offset: number) => formatInTimeZone(new Date(Date.now() + offset * 86_400_000), TZ, "yyyy-MM-dd");
    const [day1, day2] = [dayKey(1), dayKey(2)];
    const weekEnd = new Date(Date.parse(`${liveWeekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    test.skip(day2 > weekEnd, "the next two days are not both in the live week today");
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);

    // a shared car with no ride on either day
    const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id");
    const { data: busy } = await service.from("rides").select("car_id").neq("status", "cancelled")
      .gte("ends_at", `${day1}T00:00:00+02:00`).lt("starts_at", `${day2}T23:59:59+02:00`);
    const carId = (cars ?? []).map((c) => c.id as string).find((id) => !(busy ?? []).some((r) => r.car_id === id));
    test.skip(!carId, "no shared car is free on both days");

    const sadranClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { error: authError } = await sadranClient.auth.signInWithPassword(SEEDED_USERS.sadran);
    if (authError) throw authError;
    const { data: submitResult, error: submitError } = await sadranClient.rpc("submit_series_request", {
      payload: {
        department_id: NEVO_DEPARTMENT_ID, requester_id: MEMBER_ID, ride_type_id: "00000000-0000-0000-0000-000000000021",
        destination_text: DESTINATION, trip_shape: "round_trip", adults: 1,
        depart_at: `${day1}T06:00:00+02:00`, return_at: `${day2}T07:00:00+02:00`,
      },
    });
    if (submitError) throw submitError;
    const seriesId = (submitResult as { series_id: string }).series_id;
    try {
      // a live week places the series at once when a car is free (auto-approve); otherwise place it on the free car
      const placedRides = async () => (await service.from("rides").select("id, starts_at, car_id").eq("series_id", seriesId).neq("status", "cancelled").order("starts_at")).data ?? [];
      if ((await placedRides()).length < 2) {
        const { error: placeError } = await service.rpc("place_series", { p_series_id: seriesId, p_car_id: carId! });
        if (placeError) throw placeError;
      }
      const dayRides = await placedRides();
      expect(dayRides.length).toBe(2);
      const placedCar = dayRides[0]!.car_id;

      await page.setViewportSize({ width: 1440, height: 900 });
      await signIn(page, SEEDED_USERS.member1);
      await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${liveWeekStart}`);
      await page.getByRole("radio").nth(new Date(`${day1}T12:00:00Z`).getUTCDay()).click();
      // the 06:00–23:59 block is taller than the screen: its summary popup must still open on screen
      await openRideDetails(page, page.locator(`[data-ride-id="${dayRides[0]!.id}"]:visible`));
      await page.getByRole("dialog").getByRole("button", { name: t("action.cancelRide"), exact: true }).click();
      await expect(page.getByText(he.request.seriesCancelTitle)).toBeVisible();
      await expect(page.getByRole("button", { name: he.request.cancelAllDays })).toBeVisible();
      const dayLabel = tv("request.cancelOnlyDay", { day: "" }).trim();
      await expect(page.getByTestId("cancel-only-day")).toContainText(dayLabel);
      await page.getByTestId("cancel-only-day").click();
      // the usual freed-car check may ask first when someone waiting would get the car
      const freedConfirm = page.getByRole("button", { name: he.freedCar.confirmSave, exact: true });
      const done = page.getByText(tv("request.cancelOnlyDayDone", { day: formatDayDate(dayRides[0]!.starts_at as string) }));
      await expect(freedConfirm.or(done)).toBeVisible({ timeout: 15_000 });
      if (await freedConfirm.isVisible()) await freedConfirm.click();
      await expect(done).toBeVisible();

      await expect.poll(async () => {
        const { data } = await service.from("requests").select("status, series_id").eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION).order("depart_at");
        return (data ?? []).map((row) => `${row.status === "assigned" ? "placed" : "not placed"}:${row.series_id ? "series" : "single"}`).join(",");
      }).toBe("not placed:single,placed:single");
      const { data: after } = await service.from("rides").select("status, car_id").in("id", dayRides.map((r) => r.id));
      expect(after?.map((r) => r.status === "cancelled").sort()).toEqual([false, true]);
      expect(after?.find((r) => r.status !== "cancelled")?.car_id).toBe(placedCar);
    } finally {
      const { data: reqs } = await service.from("requests").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
      const ids = (reqs ?? []).map((r) => r.id as string);
      const { data: links } = ids.length ? await service.from("ride_requests").select("ride_id").in("request_id", ids) : { data: [] };
      const rideIds = [...new Set((links ?? []).map((l) => l.ride_id as string))];
      if (rideIds.length) { await service.from("ride_requests").delete().in("ride_id", rideIds); await service.from("rides").delete().in("id", rideIds); }
      if (ids.length) await service.from("requests").delete().in("id", ids);
    }
  });
});
