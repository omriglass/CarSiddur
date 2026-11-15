import { expect, test, type Page } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";

// REQ item 241 (R20H3, owner 2026-11-14/15): one-way legs dropped by hand on the board.
//  - home→Haifa on a car whose next ride starts at home asks "לשבץ בכל זאת?"; the unplaced Haifa→home return that fits
//    is offered with it ("לשבץ את שתיהן") and both go on the car.
//  - a lone Haifa→home leg dropped on a car standing at home asks "לשבץ בכל זאת?" (the car is not there) instead of
//    refusing, and is placed from Haifa.
// The fixture week is never published (as board-coordination.spec.ts): every step is the Sadran's.
const WEEK = "2042-01-05";
const HOME = "00000000-0000-0000-0000-000000000010";
const HAIFA = "00000000-0000-0000-0000-000000000011";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";
const M1 = "00000000-0000-0000-0000-000000000103";
const M2 = "00000000-0000-0000-0000-000000000104";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  if (!existing) {
    const before = (days: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - days * 86_400_000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: before(7), close_at: before(3), publish_at: before(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    const { error } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (error) throw error;
  }
}

async function cleanup(service: SupabaseClient): Promise<void> {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

function oneWay(requester: string, origin: string, destination: string, departAt: string) {
  return {
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: requester, filed_by: requester, ride_type_id: RIDE_TYPE,
    origin_id: origin, destination_id: destination, trip_shape: "one_way_to", trip_type: "one_way", needs_car_at_destination: true, one_way_car_mode: "relay",
    depart_at: departAt, status: "submitted",
  };
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

async function placedRide(service: SupabaseClient, requestId: string) {
  const { data } = await service.from("ride_requests").select("rides!inner(car_id, origin_id, destination_id, status)").eq("request_id", requestId);
  return (data ?? []).map((row) => row.rides as unknown as { car_id: string; origin_id: string; destination_id: string; status: string }).find((ride) => ride.status !== "cancelled") ?? null;
}

test.describe("one-way legs dropped by hand (REQ item 241)", { tag: ["@board"] }, () => {
  test.slow();
  let service: SupabaseClient;
  let carId: string;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    await ensureUnpublishedWeek(service);
    await cleanup(service);
    const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1);
    carId = cars![0]!.id as string;
  });
  test.afterEach(async () => { await cleanup(service); });

  test("\"לשבץ את שתיהן\" places the out-leg and the return that fits on one car", async ({ browser }) => {
    const { data: requests, error } = await service.from("requests").insert([
      oneWay(M1, HOME, HAIFA, at("08:00")),
      oneWay(M2, HAIFA, HOME, at("14:00")),
      // the car's next ride of the day starts at home, so the out-leg alone would leave it in Haifa
      { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: M1, filed_by: M1, ride_type_id: RIDE_TYPE, destination_id: HAIFA, origin_id: HOME, trip_shape: "round_trip", trip_type: "round_trip", needs_car_at_destination: true, one_way_car_mode: null, depart_at: at("18:00"), return_at: at("20:00"), status: "assigned" },
    ]).select("id");
    if (error) throw error;
    const [outReq, returnReq, laterReq] = requests!.map((row) => row.id as string);
    const { data: later, error: rideError } = await service.from("rides").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: carId, created_by: M1, driver_id: M1,
      origin_id: HOME, destination_id: HOME, status: "draft", starts_at: at("18:00"), ends_at: at("20:00"), blocked_until: at("20:30") }).select("id").single();
    if (rideError) throw rideError;
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: later!.id, request_id: laterReq, role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await sadran.page.setViewportSize({ width: 1600, height: 1100 });
      await sadran.page.goto(boardUrl);
      await dragRequest(sadran.page, outReq!, carId, 480);
      await expect(sadran.page.getByRole("heading", { name: he.sadranBoard.chainBreakTitle })).toBeVisible();
      await expect(sadran.page.getByTestId("chain-break-pair")).toBeVisible();
      await sadran.page.getByTestId("chain-break-pair-both").click();
      await expect.poll(async () => [await placedRide(service, outReq!), await placedRide(service, returnReq!)]
        .map((ride) => ride ? `${ride.car_id === carId ? "car" : "other"}:${ride.origin_id === HOME ? "home" : "haifa"}->${ride.destination_id === HOME ? "home" : "haifa"}` : "none").join(","),
      { timeout: 15_000 }).toBe("car:home->haifa,car:haifa->home");
    } finally {
      await sadran.context.close();
    }
  });

  test("a lone return leg on a car standing at home asks \"לשבץ בכל זאת?\" instead of refusing, then is placed from Haifa", async ({ browser }) => {
    const { data: requests, error } = await service.from("requests").insert([oneWay(M2, HAIFA, HOME, at("14:00"))]).select("id");
    if (error) throw error;
    const returnReq = requests![0]!.id as string;

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await sadran.page.setViewportSize({ width: 1600, height: 1100 });
      await sadran.page.goto(boardUrl);
      await dragRequest(sadran.page, returnReq, carId, 840);
      const dialog = sadran.page.getByRole("dialog").filter({ has: sadran.page.getByRole("heading", { name: he.sadranBoard.chainBreakTitle }) });
      await expect(dialog).toBeVisible();
      // "<car> לא נמצא בחיפה בשעה הזו (הוא בגבעת חביבה). ..."
      await expect(dialog).toContainText("חיפה");
      await expect(dialog).toContainText("גבעת חביבה");
      await expect(sadran.page.getByTestId("chain-break-pair")).toHaveCount(0);
      await dialog.getByRole("button", { name: he.sadranBoard.chainBreakConfirm, exact: true }).click();
      await expect.poll(async () => {
        const ride = await placedRide(service, returnReq);
        return ride ? `${ride.car_id === carId ? "car" : "other"}:${ride.origin_id === HAIFA ? "haifa" : "?"}->${ride.destination_id === HOME ? "home" : "?"}` : "none";
      }, { timeout: 15_000 }).toBe("car:haifa->home");
    } finally {
      await sadran.context.close();
    }
  });
});
