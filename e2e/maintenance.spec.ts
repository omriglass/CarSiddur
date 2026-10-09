import { expect, test } from "@playwright/test";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { TZ } from "../src/lib/time";

import { getWeekStart, newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient } from "./helpers";

// REQ §13.114 (owner 2026-10-09) — scheduled car maintenance. Written for the pilot fix round (P6); the lead runs it.
const PROFILE = { member1: "00000000-0000-0000-0000-000000000103", member2: "00000000-0000-0000-0000-000000000104" } as const;
/** Seeded: shared car "יונדאי 1", responsible person = member1 (supabase/seed.sql). */
const CAR_ID = "00000000-0000-0000-0000-000000000040";

function shiftDayKey(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function weekStripDayIndex(dayKey: string): number {
  return Number(formatInTimeZone(new Date(`${dayKey}T12:00:00Z`), TZ, "i")) % 7;
}

test.describe("scheduled maintenance", { tag: ["@maintenance"] }, () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the responsible member sets a period from the car page; the car page shows 'next maintenance'", async ({ browser }) => {
    const client = serviceRoleClient();
    const day = shiftDayKey(formatInTimeZone(new Date(), TZ, "yyyy-MM-dd"), 40);
    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await member1.page.goto(paths.car(CAR_ID));
      await expect(member1.page.getByTestId("car-maintenance-panel")).toBeVisible();
      await expect(member1.page.getByTestId("car-next-maintenance")).toContainText(he.maintenancePeriod.none);
      await member1.page.getByTestId("car-add-maintenance").click();
      const dialog = member1.page.getByRole("dialog");
      await dialog.getByTestId("maintenance-from-date").fill(day);
      await dialog.getByTestId("maintenance-to-date").fill(shiftDayKey(day, 2));
      await dialog.getByTestId("maintenance-save").click();
      await expect(dialog).not.toBeVisible();
      await expect(member1.page.getByTestId("car-next-maintenance")).toContainText(he.maintenancePeriod.next.split("{{")[0]!.trim());
      const { data } = await client.from("car_maintenance_blocks").select("starts_at,ends_at,created_by").eq("car_id", CAR_ID);
      expect(data?.length).toBe(1);
      expect(data?.[0]?.created_by).toBe(PROFILE.member1);
    } finally {
      await member1.context.close();
      await client.from("car_maintenance_blocks").delete().eq("car_id", CAR_ID);
    }
  });

  test("the band is drawn on the siddur; the responsible member shortens it by dragging, another member sees it read-only", async ({ browser }) => {
    const client = serviceRoleClient();
    const liveWeekStart = await getWeekStart("live");
    const todayKey = formatInTimeZone(new Date(), TZ, "yyyy-MM-dd");
    // Prefer tomorrow (never in the past at any hour); today only before 21:00, because shortening a
    // 09:00–23:00 block by dragging must not move its end into the past.
    const inWeek = (key: string) => key >= liveWeekStart && key <= shiftDayKey(liveWeekStart, 6);
    const tomorrowKey = shiftDayKey(todayKey, 1);
    const hourNow = Number(formatInTimeZone(new Date(), TZ, "H"));
    const day = inWeek(tomorrowKey) ? tomorrowKey : todayKey;
    test.skip(!inWeek(day) || (day === todayKey && hourNow >= 21), "no future day of the seeded live week left for a drag test");
    // The block ends late in the evening so that shortening it by an hour stays in the future whenever the spec runs
    // (an end moved into the past is refused).
    const at = (time: string) => fromZonedTime(`${day}T${time}:00`, TZ).toISOString();
    const { data: made, error } = await client.from("car_maintenance_blocks")
      .insert({ car_id: CAR_ID, department_id: NEVO_DEPARTMENT_ID, starts_at: at("09:00"), ends_at: at("23:00"), reason: "SCHEDULED", created_by: PROFILE.member2 })
      .select("id").single();
    if (error) throw error;
    const blockId = made!.id as string;

    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      for (const { page } of [member1, member2]) {
        await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeekStart }));
        const dayRadio = page.locator('[role="radio"]:visible').nth(weekStripDayIndex(day));
        await dayRadio.click();
        await expect(page.locator(`[data-block-id="${blockId}"]`)).toBeVisible();
      }
      // another member (not responsible, not Sadran): read-only band, no handles
      await expect(member2.page.locator(`[data-block-id="${blockId}"] [data-block-handle]`)).toHaveCount(0);
      // the responsible member (created by someone else) can drag the end handle upwards by one hour
      const handle = member1.page.locator(`[data-block-id="${blockId}"] [data-block-handle="end"]`);
      await expect(handle).toBeVisible();
      await handle.scrollIntoViewIfNeeded();
      const box = (await handle.boundingBox())!;
      const startX = box.x + box.width / 2;
      const startY = box.y + box.height / 2;
      await member1.page.mouse.move(startX, startY);
      await member1.page.mouse.down();
      await member1.page.mouse.move(startX, startY - 80, { steps: 8 });
      await member1.page.mouse.up();
      await expect.poll(async () => {
        const { data } = await client.from("car_maintenance_blocks").select("ends_at").eq("id", blockId).single();
        return data ? Date.parse(data.ends_at as string) : 0;
      }).toBeLessThan(Date.parse(at("23:00")));
    } finally {
      await member1.context.close();
      await member2.context.close();
      await client.from("car_maintenance_blocks").delete().eq("id", blockId);
    }
  });

  test("admin sees the next maintenance on the cars list", async ({ browser }) => {
    const client = serviceRoleClient();
    const day = shiftDayKey(formatInTimeZone(new Date(), TZ, "yyyy-MM-dd"), 30);
    const at = (time: string) => fromZonedTime(`${day}T${time}:00`, TZ).toISOString();
    await client.from("car_maintenance_blocks").insert({ car_id: CAR_ID, department_id: NEVO_DEPARTMENT_ID, starts_at: at("10:00"), ends_at: at("19:00"), reason: "SCHEDULED", created_by: PROFILE.member1 });
    const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
    try {
      await admin.page.goto("/admin/cars");
      await expect(admin.page.getByTestId("car-next-maintenance-cell").filter({ hasText: "10:00–19:00" })).toHaveCount(1);
    } finally {
      await admin.context.close();
      await client.from("car_maintenance_blocks").delete().eq("car_id", CAR_ID);
    }
  });
});
