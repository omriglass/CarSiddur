import { expect, test } from "@playwright/test";

import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// Quick request from an empty slot (UX_FLOWS.md §18, REQUIREMENTS §8 "new request on a free
// car"): clicking an empty grid cell on the LIVE week's published siddur (≥ lg viewport) opens
// a compact QuickRequestSheet targeting exactly that car/day/time. Two cases:
//  1. the clicked car is free the whole window -> assigned to exactly it.
//  2. the clicked cell is within the turnaround buffer of an existing ride on that car ->
//     inline warning shown, and submitting anyway falls back to a different free car
//     (try_auto_approve()'s own fallback, REQ §8).
// Case 2 deliberately reuses the ride case 1 itself creates (same car/day) rather than the
// static seed data, since other e2e files (freed-slot.spec.ts) mutate the seeded live week's
// own rides and this suite shares one seed across the whole run (playwright.config.ts).
//
// Vertical-board redesign (UX_FLOWS.md §20): cars are now columns, hours are rows (time
// flows top→bottom) — `[data-car-row-id]` became `[data-car-col-id]` and a click's vertical
// (y) offset within that column maps to the time, not the horizontal (x) offset within a row.
// The default display range is 06:00–23:59 on the selected Jerusalem day.
const DEST_1 = "בדיקת בקשה מהירה — רכב פנוי";
const DEST_2 = "בדיקת בקשה מהירה — רכב תפוס";
const VAN_NAME = "ואן 7 מקומות";
const FRIDAY_INDEX = 5;
const DAY_START_MINUTES = 6 * 60;
const DAY_END_MINUTES = 24 * 60;

/** Physical y offset (px) for a given minutes-since-midnight, matching `WeekGrid`'s own `clampRideVertical`. */
function yForMinutes(minutes: number, colHeight: number): number {
  return ((minutes - DAY_START_MINUTES) / (DAY_END_MINUTES - DAY_START_MINUTES)) * colHeight;
}

test.describe.serial("quick request from an empty slot (live week)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, SEEDED_USERS.member2);
  });

  test("clicking an empty cell assigns exactly the clicked car", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    const admin = serviceRoleClient();
    const { data: cars } = await admin
      .from("cars")
      .select("id, name")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("type", "shared");
    const van = cars?.find((c) => c.name === VAN_NAME);
    expect(van).toBeTruthy();

    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${liveWeekStart}`);
    const dayRadios = page.getByRole("radiogroup", { name: "יום" });
    // Two WeekStrip instances exist (phone + desktop, only one visible per viewport) — the
    // desktop one (this test's ≥ lg viewport) is the later one in DOM order.
    await dayRadios.last().getByRole("radio").nth(FRIDAY_INDEX).click();

    const col = page.locator(`[data-car-col-id="${van!.id}"]`);
    await expect(col).toBeVisible();
    const box = await col.boundingBox();
    if (!box) throw new Error("car column not found");
    await col.click({ position: { x: box.width / 2, y: yForMinutes(600, box.height) } }); // 10:00

    await expect(page.getByText(new RegExp(`לוקח/ת את ${VAN_NAME}`))).toBeVisible();

    await page.getByPlaceholder("לאן?").fill(DEST_1);
    await page.getByText(`"${DEST_1}" — יעד חופשי`).click();
    await page.getByRole("button", { name: "קח/י את הרכב" }).click();

    await expect(page.getByText(/הרכב שלך/)).toBeVisible({ timeout: 10_000 });
    await expect(col.locator("button[data-ride-id]")).toBeVisible({ timeout: 10_000 });

    await page.goto("/requests");
    const requestCard = page.locator("div.rounded-md", { hasText: DEST_1 });
    await expect(requestCard.getByText("שובצה")).toBeVisible({ timeout: 10_000 });

    const { data: reqRow } = await admin
      .from("requests")
      .select("id, preferred_car_id")
      .eq("destination_text", DEST_1)
      .maybeSingle();
    expect(reqRow?.preferred_car_id).toBe(van!.id);

    const { data: rideRequest } = await admin
      .from("ride_requests")
      .select("ride_id")
      .eq("request_id", reqRow!.id)
      .maybeSingle();
    const { data: ride } = await admin.from("rides").select("car_id").eq("id", rideRequest!.ride_id).maybeSingle();
    expect(ride?.car_id).toBe(van!.id);
  });

  test("clicking a cell within the buffer of an existing ride falls back to another car", async ({ page }) => {
    const liveWeekStart = await getWeekStart("live");
    const admin = serviceRoleClient();
    const { data: cars } = await admin
      .from("cars")
      .select("id, name")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("type", "shared");
    const van = cars?.find((c) => c.name === VAN_NAME);
    expect(van).toBeTruthy();

    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${liveWeekStart}`);
    const dayRadios = page.getByRole("radiogroup", { name: "יום" });
    await dayRadios.last().getByRole("radio").nth(FRIDAY_INDEX).click();

    const col = page.locator(`[data-car-col-id="${van!.id}"]`);
    await expect(col).toBeVisible();
    // The previous test placed a 10:00-12:00 ride on this exact car/day (turnaround buffer
    // extends its blocked window to 12:30) — 12:15 renders as visually empty (no ride block
    // covers it) but is still inside that buffer, so it exercises the "clicked car busy"
    // fallback rather than accidentally clicking the existing ride block itself.
    const box = await col.boundingBox();
    if (!box) throw new Error("car column not found");
    await col.click({ position: { x: box.width / 2, y: yForMinutes(12 * 60 + 15, box.height) } });

    await expect(page.getByText(new RegExp(`לוקח/ת את ${VAN_NAME}`))).toBeVisible();
    await expect(page.getByText("הרכב הזה תפוס (או קרוב מדי לנסיעה אחרת) בשעות האלה")).toBeVisible();

    await page.getByPlaceholder("לאן?").fill(DEST_2);
    await page.getByText(`"${DEST_2}" — יעד חופשי`).click();
    await page.getByRole("button", { name: "קח/י את הרכב" }).click();

    await expect(page.getByText(/שובץ במקום/)).toBeVisible({ timeout: 10_000 });

    const { data: reqRow } = await admin
      .from("requests")
      .select("id, preferred_car_id")
      .eq("destination_text", DEST_2)
      .maybeSingle();
    expect(reqRow?.preferred_car_id).toBe(van!.id);

    const { data: rideRequest } = await admin
      .from("ride_requests")
      .select("ride_id")
      .eq("request_id", reqRow!.id)
      .maybeSingle();
    const { data: ride } = await admin.from("rides").select("car_id").eq("id", rideRequest!.ride_id).maybeSingle();
    expect(ride?.car_id).toBeTruthy();
    expect(ride?.car_id).not.toBe(van!.id);
  });
});
