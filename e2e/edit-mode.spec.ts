import { expect, test, type Page } from "@playwright/test";
import { publishedFixtureWeek } from "./published-week";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

// Owner 2026-10-30: on the member's siddur a ride drags only after a long press, or at once with edit mode (the pencil) on.
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-03-17";
const MEMBER1 = "00000000-0000-0000-0000-000000000103";

async function dragDown(page: Page, block: ReturnType<Page["locator"]>, px: number, holdMs = 0) {
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (holdMs) await page.waitForTimeout(holdMs);
  await page.mouse.move(x, y + px, { steps: 8 });
  await page.mouse.up();
}

test("a siddur ride drags only after a long press or in edit mode", { tag: ["@siddur"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1).single();
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  const { data: request, error: requestError } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: MEMBER1, filed_by: MEMBER1,
    ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: "E2E edit mode",
    trip_shape: "round_trip", depart_at: `${WEEK}T10:00:00+02:00`, return_at: `${WEEK}T11:00:00+02:00`, status: "assigned",
  }).select("id").single();
  if (requestError) throw requestError;
  const { data: ride, error: rideError } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: car!.id, driver_id: MEMBER1, created_by: MEMBER1,
    starts_at: `${WEEK}T10:00:00+02:00`, ends_at: `${WEEK}T11:00:00+02:00`, blocked_until: `${WEEK}T11:30:00+02:00`,
    origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed",
  }).select("id").single();
  if (rideError) throw rideError;
  const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: request!.id, role: "driver", leg: "both", car_mode: "keep" });
  if (linkError) throw linkError;
  const startsAt = async () => {
    const { data } = await service.from("rides").select("starts_at").eq("id", ride!.id).single();
    return new Date(data!.starts_at as string).toISOString();
  };

  const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
  try {
    const page = member1.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    const block = page.locator(`[data-ride-id="${ride!.id}"]:visible`);
    await expect(block).toBeVisible();
    const pencil = page.getByTestId("edit-mode-button").locator("visible=true");
    await expect(pencil).toBeVisible();
    await expect(pencil).not.toHaveAttribute("data-on", "true");

    // Off: a plain drag moves nothing; the second attempt says how to drag.
    await dragDown(page, block, 80);
    await dragDown(page, block, 80);
    await expect(page.getByText(he.editMode.hintLocked)).toBeVisible();
    expect(await startsAt()).toBe("2041-03-17T08:00:00.000Z");

    // Off: a long press drags.
    await dragDown(page, block, 80, 800);
    await expect.poll(startsAt).toBe("2041-03-17T09:00:00.000Z");

    // On: a drag moves the ride at once.
    await pencil.click();
    await expect(pencil).toHaveAttribute("data-on", "true");
    await dragDown(page, page.locator(`[data-ride-id="${ride!.id}"]:visible`), 80);
    await expect.poll(startsAt).toBe("2041-03-17T10:00:00.000Z");

    // O30-2: the phone's list view drags nothing, so it has no pencil (the table view keeps it).
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("siddur-desktop-week-switcher")).toBeHidden();
    await expect(page.getByTestId("edit-mode-button").locator("visible=true")).toHaveCount(0);
  } finally {
    await member1.context.close().catch(() => undefined);
    await service.from("ride_requests").delete().eq("ride_id", ride!.id);
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  }
});
