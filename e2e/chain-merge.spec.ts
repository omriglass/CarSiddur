import { expect, test, type Locator, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * CM1 phase 2 (REQ item 260 b): the same person's two trips one after the other merge into ONE chained ride.
 * member1 drops the kids in בנימינה (home 07:45 -> בנימינה -> home 08:15) and drives to פרדס חנה for the day
 * (08:30-14:00). The Sadran drops the short trip on the day trip on the board; member1 drags one of his own rides onto
 * the other in the siddur's edit mode. Either way: one ride home -> בנימינה -> פרדס חנה -> home, 07:45-14:00, the short
 * trip's row chained `before`, the popup showing the chained route.
 */
test.use({ actionTimeout: 15_000 });

const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const HOME = "00000000-0000-0000-0000-000000000010";
const BINYAMINA = "00000000-0000-0000-0000-000000000012";
const PARDES_HANA = "00000000-0000-0000-0000-000000000017";
const TYPE = "00000000-0000-0000-0000-000000000021";

async function cleanup(service: SupabaseClient, week: string) {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  const { data: offers } = await service.from("freed_slot_offers").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (offers?.length) await service.from("freed_slot_claims").delete().in("offer_id", offers.map((o) => o.id));
  await service.from("freed_slot_offers").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("held_notices").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
}

/** The day trip on car 1 (member1 drives); the school run either unplaced or on car 2. */
async function fixture(service: SupabaseClient, week: string, shortPlaced: boolean, status: "draft" | "confirmed", withCompanion = false) {
  const at = (time: string) => `${week}T${time}:00+02:00`;
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(2);
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: week, ride_type_id: TYPE, requester_id: MEMBER1, filed_by: MEMBER1, origin_id: HOME, trip_shape: "round_trip", trip_type: "round_trip" };
  const { data: short, error } = await service.from("requests").insert(
    { ...base, destination_id: BINYAMINA, depart_at: at("07:45"), return_at: at("08:15"), status: shortPlaced ? "assigned" : "submitted" },
  ).select("id").single();
  if (error) throw error;
  const { data: day, error: dayError } = await service.from("requests").insert(
    { ...base, destination_id: PARDES_HANA, depart_at: at("08:30"), return_at: at("14:00"), status: "assigned", adults: withCompanion ? 2 : 1 },
  ).select("id").single();
  if (dayError) throw dayError;
  if (withCompanion) {
    // CM1 phase 3: member2 is on the day trip only
    const { error: compError } = await service.from("request_companions").insert({ request_id: day.id, profile_id: MEMBER2 });
    if (compError) throw compError;
  }
  const ride = async (carId: string, from: string, to: string) => {
    const { data, error: rideError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, created_by: MEMBER1, driver_id: MEMBER1, needs_driver: false,
      origin_id: HOME, destination_id: HOME, status, starts_at: at(from), ends_at: at(to),
    }).select("id").single();
    if (rideError) throw rideError;
    return data.id as string;
  };
  const dayRide = await ride(cars![0]!.id, "08:30", "14:00");
  const { error: linkError } = await service.from("ride_requests").insert({ ride_id: dayRide, request_id: day.id, role: "driver", leg: "both", car_mode: "keep" });
  if (linkError) throw linkError;
  let shortRide: string | null = null;
  if (shortPlaced) {
    shortRide = await ride(cars![1]!.id, "07:45", "08:15");
    const { error: shortLink } = await service.from("ride_requests").insert({ ride_id: shortRide, request_id: short.id, role: "driver", leg: "both", car_mode: "keep" });
    if (shortLink) throw shortLink;
  }
  return { carId: cars![0]!.id as string, shortId: short.id as string, dayId: day.id as string, dayRide, shortRide, at };
}

async function dragRequest(page: Page, requestId: string, carId: string, minutes: number) {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await scrollGridColumnTo(column, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

async function dragOnto(page: Page, from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + a.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function expectChained(service: SupabaseClient, rideId: string, shortId: string, startsAt: string, endsAt: string, via = false) {
  await expect.poll(async () => (await service.from("ride_requests").select("chain").eq("ride_id", rideId).eq("request_id", shortId).maybeSingle()).data?.chain)
    .toBe(via ? "before_via" : "before");
  const { data: ride } = await service.from("rides").select("starts_at,ends_at").eq("id", rideId).single();
  expect(Date.parse(ride!.starts_at)).toBe(Date.parse(startsAt));
  expect(Date.parse(ride!.ends_at)).toBe(Date.parse(endsAt));
  const { data: route } = await service.rpc("ride_route", { p_ride_id: rideId });
  const places = (route as { leg: string; position: number; place_id: string }[])
    .sort((x, y) => x.leg.localeCompare(y.leg) || x.position - y.position).map((p) => p.place_id);
  expect(places).toEqual(via ? [HOME, BINYAMINA, HOME, PARDES_HANA, PARDES_HANA, HOME] : [HOME, BINYAMINA, PARDES_HANA, PARDES_HANA, HOME]);
}

async function boardWeek(service: SupabaseClient, week: string) {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (existing) return;
  const day = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
  const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "solving", open_at: day(7), close_at: day(3), publish_at: day(2) });
  if (error) throw error;
}

test("the Sadran drops the school run on the day trip: one chained ride", { tag: ["@board"] }, async ({ browser }) => {
  test.slow();
  const week = "2042-03-02";
  const service = serviceRoleClient();
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (!existing) {
    const day = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "solving", open_at: day(7), close_at: day(3), publish_at: day(2) });
    if (error) throw error;
  }
  await cleanup(service, week);
  const { carId, shortId, dayRide, at } = await fixture(service, week, false, "draft");
  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`);
    await dragRequest(page, shortId, carId, 540);
    const dialog = page.getByTestId("merge-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("merge-result-chain")).toContainText(he.mergedRide.chainRoute.split("{{")[0]!.trim());
    await expect(dialog.getByTestId("merge-result-chain")).toContainText("פרדס חנה");
    await expect(dialog.getByTestId("merge-invalid")).toHaveCount(0);
    await dialog.getByTestId("merge-agreed").click();
    await expectChained(service, dayRide, shortId, at("07:45"), at("14:00"));
  } finally {
    await sadran.context.close().catch(() => undefined);
    await cleanup(service, week);
  }
});

test("a member drags their school run onto their day trip in edit mode: one chained ride", { tag: ["@siddur"] }, async ({ browser }) => {
  test.slow();
  const week = "2041-03-03";
  const service = serviceRoleClient();
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  await cleanup(service, week);
  const { shortId, dayId, dayRide, shortRide, at } = await fixture(service, week, true, "confirmed");
  const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
  try {
    const page = member1.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
    const short = page.locator(`[data-ride-id="${shortRide}"]:visible`);
    const day = page.locator(`[data-ride-id="${dayRide}"]:visible`);
    await expect(short).toBeVisible();
    await expect(day).toBeVisible();
    await page.getByTestId("edit-mode-button").locator("visible=true").click();
    await dragOnto(page, short, day);
    const ask = page.getByRole("dialog").filter({ hasText: he.rideEditing.chainTitle });
    await expect(ask).toContainText("פרדס חנה");
    await ask.getByRole("button", { name: he.rideEditing.mergeConfirm }).click();
    // the dragged ride (the school run's) is the one kept; the day trip joins it and becomes the route base
    await expect.poll(async () => (await service.from("ride_requests").select("ride_id").eq("request_id", dayId).maybeSingle()).data?.ride_id)
      .toBe(shortRide);
    await expectChained(service, shortRide!, shortId, at("07:45"), at("14:00"));
    const { data: gone } = await service.from("rides").select("status").eq("id", dayRide).single();
    expect(gone!.status).toBe("cancelled");
  } finally {
    await member1.context.close().catch(() => undefined);
    await cleanup(service, week);
  }
});

// CM1 phase 3 (REQ item 260 c): member2 rides the day trip only - "לכל הנסיעה" is preselected, "לאסוף מ..." passes home again
test("the Sadran chains with a pickup from home for the one on the day trip only", { tag: ["@board"] }, async ({ browser }) => {
  test.slow();
  const week = "2042-03-09";
  const service = serviceRoleClient();
  await boardWeek(service, week);
  await cleanup(service, week);
  const { carId, shortId, dayRide, at } = await fixture(service, week, false, "draft", true);
  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`);
    await dragRequest(page, shortId, carId, 540);
    const dialog = page.getByTestId("merge-dialog");
    await expect(dialog.getByTestId("chain-one-trip")).toBeVisible();
    await expect(dialog.getByTestId("chain-one-trip-plain")).toHaveAttribute("aria-checked", "true");
    await dialog.getByTestId("chain-one-trip-via").click();
    await expect(dialog.getByTestId("chain-one-trip-via")).toHaveAttribute("aria-checked", "true");
    await dialog.getByTestId("merge-agreed").click();
    await expectChained(service, dayRide, shortId, at("07:45"), at("14:00"), true);
  } finally {
    await sadran.context.close().catch(() => undefined);
    await cleanup(service, week);
  }
});

test("a member chains their two rides and has the one on the day trip picked up from home", { tag: ["@siddur"] }, async ({ browser }) => {
  test.slow();
  const week = "2041-03-10";
  const service = serviceRoleClient();
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  await cleanup(service, week);
  const { shortId, dayRide, shortRide, at } = await fixture(service, week, true, "confirmed", true);
  const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
  try {
    const page = member1.page;
    await page.setViewportSize({ width: 1440, height: 1400 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
    const short = page.locator(`[data-ride-id="${shortRide}"]:visible`);
    const day = page.locator(`[data-ride-id="${dayRide}"]:visible`);
    await expect(short).toBeVisible();
    await page.getByTestId("edit-mode-button").locator("visible=true").click();
    await dragOnto(page, short, day);
    const ask = page.getByRole("dialog").filter({ hasText: he.rideEditing.chainTitle });
    await ask.getByTestId("chain-one-trip-via").click();
    await ask.getByRole("button", { name: he.rideEditing.mergeConfirm }).click();
    await expectChained(service, shortRide!, shortId, at("07:45"), at("14:00"), true);
  } finally {
    await member1.context.close().catch(() => undefined);
    await cleanup(service, week);
  }
});
