import { expect, test, type Page } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

// REQ §13.205 (b), owner 2026-11-09: with the department's "anyone edits rides" switch on, a member drags someone
// else's ride on the siddur (edit mode); the move asks "did you talk with X?" first, like any move of another's part.
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-03-24"; // a Sunday
const MEMBER1 = "00000000-0000-0000-0000-000000000103";

async function dragDown(page: Page, block: ReturnType<Page["locator"]>, px: number) {
  await block.scrollIntoViewIfNeeded();
  const box = (await block.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + px, { steps: 8 });
  await page.mouse.up();
}

test("with the switch on a member drags another member's ride", { tag: ["@siddur"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1).single();
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: request, error: requestError } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: MEMBER1, filed_by: MEMBER1,
    ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: "E2E anyone drags",
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

  await service.from("department_settings").update({ anyone_edits_rides: true }).eq("department_id", NEVO_DEPARTMENT_ID);
  const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
  try {
    const page = member2.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
    const block = page.locator(`[data-ride-id="${ride!.id}"]:visible`);
    await expect(block).toBeVisible();
    const pencil = page.getByTestId("edit-mode-button").locator("visible=true");
    await pencil.click();
    await expect(pencil).toHaveAttribute("data-on", "true");
    await dragDown(page, block, 80);
    // the ride is member1's: the move asks first, then goes through
    await page.getByRole("button", { name: he.rideMoveAgreement.confirm, exact: true }).click();
    await expect.poll(startsAt).toBe("2041-03-24T09:00:00.000Z");
  } finally {
    await member2.context.close();
    await service.from("department_settings").update({ anyone_edits_rides: false }).eq("department_id", NEVO_DEPARTMENT_ID);
    await service.from("ride_requests").delete().eq("ride_id", ride!.id);
    await service.from("rides").delete().eq("id", ride!.id);
    await service.from("requests").delete().eq("id", request!.id);
  }
});
