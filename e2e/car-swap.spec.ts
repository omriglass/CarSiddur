import { expect, test } from "@playwright/test";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { TZ } from "../src/lib/time";

import { getWeekStart, newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// REQ §13.92 (owner batch 2026-09-24 S1) — swap cars on a day by dragging car names.
// `supabase/seed.sql`'s fixed demo UUIDs (see CLAUDE.md folder map / e2e/helpers.ts).
const PROFILE = {
  admin: "00000000-0000-0000-0000-000000000101",
  sadran: "00000000-0000-0000-0000-000000000102",
  member1: "00000000-0000-0000-0000-000000000103",
  member2: "00000000-0000-0000-0000-000000000104",
} as const;
/** Both shared, no maintenance blocks, no seeded rides before 08:00 (supabase/seed.sql). */
const CAR = {
  hyundai1: "00000000-0000-0000-0000-000000000040",
  van7: "00000000-0000-0000-0000-000000000041",
  hyundai2: "00000000-0000-0000-0000-000000000042",
} as const;
const HOME_DESTINATION_ID = "00000000-0000-0000-0000-000000000010";
const DESTINATION_HAIFA_ID = "00000000-0000-0000-0000-000000000011";
const RIDE_TYPE_WORK_ID = "00000000-0000-0000-0000-000000000021";

/** `yyyy-MM-dd` calendar-date arithmetic (no wall-clock reading) — safe outside `src/lib/time.ts`. */
function shiftDayKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `WeekStrip`'s Sun(0)..Sat(6) day-chip index for a `yyyy-MM-dd` key (noon UTC stays inside the same Jerusalem calendar day regardless of DST). */
function weekStripDayIndex(dayKey: string): number {
  return Number(formatInTimeZone(new Date(`${dayKey}T12:00:00Z`), TZ, "i")) % 7;
}

/** The largest `car_seat_configs.adults` row for a car — never hard-code seat numbers (CLAUDE.md). */
async function carMaxAdults(client: SupabaseClient, carId: string): Promise<number> {
  const { data, error } = await client.from("car_seat_configs").select("adults").eq("car_id", carId);
  if (error) throw error;
  return Math.max(0, ...(data ?? []).map((row) => row.adults as number));
}

async function carNames(client: SupabaseClient, carIds: readonly string[]): Promise<Map<string, string>> {
  const { data, error } = await client.from("cars").select("id,name").in("id", carIds);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id as string, row.name as string]));
}

test.describe("car swap on the siddur (member, published day)", { tag: ["@siddur"] }, () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("member1 swaps two cars via the header menu; only the moved rides' drivers are notified", async ({ browser }) => {
    const liveWeekStart = await getWeekStart("live");
    const weekEnd = shiftDayKey(liveWeekStart, 6);
    const todayKey = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
    let fixtureDay = todayKey;
    if (fixtureDay < liveWeekStart || fixtureDay > weekEnd) fixtureDay = shiftDayKey(todayKey, 1);
    test.skip(
      fixtureDay < liveWeekStart || fixtureDay > weekEnd,
      "no day today-or-later remains inside the seeded live week",
    );

    const client = serviceRoleClient();
    const carA = CAR.hyundai1;
    const carB = CAR.hyundai2;
    const at = (time: string) => fromZonedTime(`${fixtureDay}T${time}:00`, TZ).toISOString();

    // Two confirmed round trips (home -> home), overlapping times, on two different shared
    // cars — one driven by member2, one by the Sadran. `v_board_rides.people` always includes
    // `rides.driver_id`, so no `ride_requests` fixture is needed to exercise the notification.
    const { data: rideARow, error: rideAError } = await client
      .from("rides")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: liveWeekStart, car_id: carA,
        starts_at: at("06:15"), ends_at: at("07:45"),
        origin_id: HOME_DESTINATION_ID, destination_id: HOME_DESTINATION_ID,
        driver_id: PROFILE.member2, created_by: PROFILE.member2, status: "confirmed",
      })
      .select("id")
      .single();
    if (rideAError) throw rideAError;
    const { data: rideBRow, error: rideBError } = await client
      .from("rides")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: liveWeekStart, car_id: carB,
        starts_at: at("06:30"), ends_at: at("08:00"),
        origin_id: HOME_DESTINATION_ID, destination_id: HOME_DESTINATION_ID,
        driver_id: PROFILE.sadran, created_by: PROFILE.sadran, status: "confirmed",
      })
      .select("id")
      .single();
    if (rideBError) throw rideBError;
    const rideAId = rideARow!.id as string;
    const rideBId = rideBRow!.id as string;

    const names = await carNames(client, [carA, carB]);

    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await member1.page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));

      // Two `WeekStrip` instances render simultaneously (phone list vs. desktop grid, CSS-hidden
      // not unmounted, same pattern as e2e/siddur-mobile.spec.ts) — scope to the visible one.
      const dayRadio = member1.page.locator('[role="radio"]:visible').nth(weekStripDayIndex(fixtureDay));
      await dayRadio.click();
      await expect(dayRadio).toHaveAttribute("aria-checked", "true");

      const headerA = member1.page.locator(`[data-car-header-id="${carA}"]`);
      await headerA.getByRole("button", { name: he.carSwap.swapMenuLabel, exact: true }).click();
      // The siddur's own car names carry a "· קוד לא הוזן"/access-code suffix (`siddurCarName()`,
      // SiddurPage's own `weekGridCars`) that the plain `cars.name` column doesn't — match by
      // substring instead of reconstructing that suffix here.
      await member1.page.getByRole("menuitem", { name: new RegExp(names.get(carB) ?? "") }).click();

      const dialog = member1.page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(member1.page.getByTestId(`car-swap-group-${carA}`)).toBeVisible();
      const confirmButton = dialog.getByRole("button", { name: he.common.confirm, exact: true });
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();
      await expect(dialog).not.toBeVisible();

      const { data: rows } = await client.from("rides").select("id,car_id").in("id", [rideAId, rideBId]);
      expect(rows?.find((r) => r.id === rideAId)?.car_id).toBe(carB);
      expect(rows?.find((r) => r.id === rideBId)?.car_id).toBe(carA);

      const { data: member2Notifs } = await client
        .from("notifications")
        .select("id")
        .eq("recipient_id", PROFILE.member2)
        .eq("event", "car_swapped");
      expect(member2Notifs?.length ?? 0).toBeGreaterThan(0);

      const { data: member1Notifs } = await client
        .from("notifications")
        .select("id")
        .eq("recipient_id", PROFILE.member1)
        .eq("event", "car_swapped");
      expect(member1Notifs?.length ?? 0).toBe(0);
    } finally {
      await member1.context.close();
      await client.from("notifications").delete().eq("event", "car_swapped");
      await client.from("rides").delete().in("id", [rideAId, rideBId]);
    }
  });
});

test.describe("car swap on the board (Sadran)", { tag: ["@board"] }, () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("sadran drags one car's header onto another's on an open week's day; the swap applies with no notifications", async ({
    page,
  }) => {
    const openWeekStart = await getWeekStart("open");
    const day = openWeekStart; // the week's own Sunday
    const client = serviceRoleClient();
    const carA = CAR.hyundai1;
    const carB = CAR.hyundai2;
    const at = (time: string) => fromZonedTime(`${day}T${time}:00`, TZ).toISOString();

    const { data: rideARow, error: rideAError } = await client
      .from("rides")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: openWeekStart, car_id: carA,
        starts_at: at("06:15"), ends_at: at("07:45"),
        origin_id: HOME_DESTINATION_ID, destination_id: HOME_DESTINATION_ID,
        driver_id: PROFILE.member1, created_by: PROFILE.member1, status: "confirmed",
      })
      .select("id")
      .single();
    if (rideAError) throw rideAError;
    const { data: rideBRow, error: rideBError } = await client
      .from("rides")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: openWeekStart, car_id: carB,
        starts_at: at("06:30"), ends_at: at("08:00"),
        origin_id: HOME_DESTINATION_ID, destination_id: HOME_DESTINATION_ID,
        driver_id: PROFILE.member2, created_by: PROFILE.member2, status: "confirmed",
      })
      .select("id")
      .single();
    if (rideBError) throw rideBError;
    const rideAId = rideARow!.id as string;
    const rideBId = rideBRow!.id as string;

    try {
      await signIn(page, SEEDED_USERS.sadran);
      await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));

      const dayRadio = page.getByRole("radio").first(); // Sunday = index 0
      await dayRadio.click();
      await expect(dayRadio).toHaveAttribute("aria-checked", "true");

      const headerA = page.locator(`[data-car-header-id="${carA}"]`);
      const headerB = page.locator(`[data-car-header-id="${carB}"]`);
      const boxA = await headerA.boundingBox();
      const boxB = await headerB.boundingBox();
      if (!boxA || !boxB) throw new Error("car header bounding box not found");

      await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + boxA.height / 2);
      await page.mouse.down();
      // First move confirms the drag (> the 6px mouse threshold); the second lands on car B's column.
      await page.mouse.move(boxA.x + boxA.width / 2 + 20, boxA.y + boxA.height / 2, { steps: 5 });
      await page.mouse.move(boxB.x + boxB.width / 2, boxB.y + boxB.height / 2, { steps: 10 });
      await page.mouse.up();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      const confirmButton = dialog.getByRole("button", { name: he.common.confirm, exact: true });
      await expect(confirmButton).toBeEnabled();
      await confirmButton.click();
      await expect(dialog).not.toBeVisible();

      const { data: rows } = await client.from("rides").select("id,car_id").in("id", [rideAId, rideBId]);
      expect(rows?.find((r) => r.id === rideAId)?.car_id).toBe(carB);
      expect(rows?.find((r) => r.id === rideBId)?.car_id).toBe(carA);

      const { data: notifs } = await client.from("notifications").select("id").eq("event", "car_swapped");
      expect(notifs?.length ?? 0).toBe(0);
    } finally {
      await client.from("rides").delete().in("id", [rideAId, rideBId]);
    }
  });

  test("a ride whose adults exceed the target car's seat capacity blocks the swap", async ({ page }) => {
    const openWeekStart = await getWeekStart("open");
    const day = openWeekStart;
    const client = serviceRoleClient();
    const sourceCar = CAR.van7;
    const targetCar = CAR.hyundai1;

    const sourceMax = await carMaxAdults(client, sourceCar);
    const targetMax = await carMaxAdults(client, targetCar);
    const adults = targetMax + 1;
    test.skip(adults > sourceMax, "the seeded fixture cars can no longer produce a seats blocker for this pair");

    const startsAt = fromZonedTime(`${day}T06:15:00`, TZ).toISOString();
    const endsAt = fromZonedTime(`${day}T07:45:00`, TZ).toISOString();

    const { data: rideRow, error: rideError } = await client
      .from("rides")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: openWeekStart, car_id: sourceCar,
        starts_at: startsAt, ends_at: endsAt,
        origin_id: HOME_DESTINATION_ID, destination_id: HOME_DESTINATION_ID,
        driver_id: PROFILE.member1, created_by: PROFILE.member1, status: "confirmed",
      })
      .select("id")
      .single();
    if (rideError) throw rideError;
    const rideId = rideRow!.id as string;

    // A driver's own request, adults counted per DATA_MODEL §5.2 (includes the driver) — sized
    // to fit the source car but exceed the target car's largest seat config.
    const { data: requestRow, error: requestError } = await client
      .from("requests")
      .insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: openWeekStart,
        requester_id: PROFILE.member1, filed_by: PROFILE.member1,
        destination_id: DESTINATION_HAIFA_ID, ride_type_id: RIDE_TYPE_WORK_ID,
        trip_shape: "round_trip", depart_at: startsAt, return_at: endsAt,
        adults, submitted_at: startsAt, status: "assigned",
      })
      .select("id")
      .single();
    if (requestError) throw requestError;
    const requestId = requestRow!.id as string;

    const { error: linkError } = await client
      .from("ride_requests")
      .insert({ ride_id: rideId, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;

    try {
      await signIn(page, SEEDED_USERS.sadran);
      await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, openWeekStart));

      const dayRadio = page.getByRole("radio").first();
      await dayRadio.click();
      await expect(dayRadio).toHaveAttribute("aria-checked", "true");

      const names = await carNames(client, [sourceCar, targetCar]);
      const header = page.locator(`[data-car-header-id="${sourceCar}"]`);
      await header.getByRole("button", { name: he.carSwap.swapMenuLabel, exact: true }).click();
      await page
        .getByRole("menuitem", { name: tv("carSwap.swapWithCar", { car: names.get(targetCar) ?? "" }), exact: true })
        .click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(page.getByTestId("car-swap-blockers")).toBeVisible();
      await expect(dialog.getByRole("button", { name: he.common.confirm, exact: true })).toBeDisabled();
    } finally {
      await client.from("ride_requests").delete().eq("ride_id", rideId);
      await client.from("requests").delete().eq("id", requestId);
      await client.from("rides").delete().eq("id", rideId);
    }
  });
});
