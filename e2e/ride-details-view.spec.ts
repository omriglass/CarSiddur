import { expect, test } from "@playwright/test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tv } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, openRideDetails, openRideSheetTab } from "./helpers";

// SD1 (REQ item 256, owner 2026-11-18/19): the Sadran's ride sheet, tab "יעדים", shows the ride's time constraints
// "לפי אנשים" (default) or "לפי מסלול", the last choice remembered per device. A set hour the ride cannot keep -
// here a guest who leaves home at 08:30 on a ride that starts at 09:00 - is a definite conflict ("✕ לא מסתדר").
const WEEK = "2042-03-09";
const HOME = "00000000-0000-0000-0000-000000000010";
const HAIFA = "00000000-0000-0000-0000-000000000011";
const RIDE_TYPE = "00000000-0000-0000-0000-000000000021";
const M1 = "00000000-0000-0000-0000-000000000103";
const M2 = "00000000-0000-0000-0000-000000000104";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function ensureUnpublishedWeek(service: SupabaseClient): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).maybeSingle();
  const before = (days: number) => new Date(Date.parse(`${WEEK}T00:00:00Z`) - days * 86_400_000).toISOString();
  if (!existing) {
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "solving", open_at: before(7), close_at: before(3), publish_at: before(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving") {
    await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  }
}

async function cleanup(service: SupabaseClient): Promise<void> {
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

test("the ride's hours per person and per route; a set hour the ride cannot keep is a conflict", { tag: ["@board", "@ride-passengers"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service);
  await cleanup(service);
  const common = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: RIDE_TYPE, origin_id: HOME, destination_id: HAIFA };
  const { data: requests, error } = await service.from("requests").insert([
    { ...common, requester_id: M1, filed_by: M1, trip_shape: "round_trip", trip_type: "round_trip", needs_car_at_destination: true, one_way_car_mode: null,
      depart_at: at("09:00"), return_at: at("13:00"), depart_anchor: "leave", flex_depart_early: "00:00:00", flex_depart_late: "00:00:00", status: "assigned" },
    { ...common, requester_id: M2, filed_by: M2, trip_shape: "one_way_to", trip_type: "one_way", one_way_car_mode: "passenger", needs_car_at_destination: false, return_at: null,
      depart_at: at("08:30"), depart_anchor: "leave", flex_depart_early: "00:00:00", flex_depart_late: "00:00:00", status: "merged" },
  ]).select("id");
  if (error) throw error;
  const [hostId, guestId] = requests!.map((row) => row.id as string);
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(1);
  const { data: ride, error: rideError } = await service.from("rides").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![0]!.id, created_by: M1, driver_id: M1,
    origin_id: HOME, destination_id: HOME, status: "draft", is_pinned: true, pin_reason: "SADRAN_MANUAL", starts_at: at("09:00"), ends_at: at("14:00") }).select("id").single();
  if (rideError) throw rideError;
  const rideId = ride!.id as string;
  const { error: linkError } = await service.from("ride_requests").insert([
    { ride_id: rideId, request_id: hostId, role: "driver", leg: "both", car_mode: "keep" },
    { ride_id: rideId, request_id: guestId, role: "passenger", leg: "out", car_mode: "passenger" },
  ]);
  if (linkError) throw linkError;

  const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
  try {
    const page = sadran.page;
    const open = async () => {
      await page.setViewportSize({ width: 1600, height: 1100 });
      await page.goto(boardUrl);
      await openRideDetails(page, page.locator(`button[data-ride-id="${rideId}"]:visible`));
      await openRideSheetTab(page, "route");
    };
    await open();
    const view = page.getByTestId("ride-details-view");
    await expect(view).toHaveAttribute("data-view", "people");
    // the driver first; the guest's 08:30 against the driver's 09:00 at the same place (the ride's start says the same, once)
    const guest = view.getByTestId("ride-details-person").nth(1);
    await expect(guest).toContainText(SEEDED_USERS.member2.fullName);
    await expect(guest.getByTestId("ride-details-conflict")).toHaveText(
      tv("rideDetails.conflictLine", { a: SEEDED_USERS.member1.fullName, t1: "09:00", b: SEEDED_USERS.member2.fullName, t2: "08:30" }));
    await expect(guest.getByTestId("ride-details-mark")).toHaveAttribute("data-mark", "conflict");
    await expect(guest).toContainText(tv("rideDetails.statedFixed", { time: "08:30" }));
    await page.setViewportSize({ width: 390, height: 1400 });
    await view.screenshot({ path: test.info().outputPath("sd1-people.png") });

    await page.getByTestId("ride-details-view-route").click();
    await expect(view).toHaveAttribute("data-view", "route");
    await expect(page.getByTestId("ride-details-place-out-0")).toContainText(tv("rideDetails.tagLeave", { name: SEEDED_USERS.member2.fullName, time: "08:30" }));
    await view.screenshot({ path: test.info().outputPath("sd1-route.png") });

    // remembered on this device
    await open();
    await expect(page.getByTestId("ride-details-view")).toHaveAttribute("data-view", "route");
  } finally {
    await sadran.context.close().catch(() => undefined);
    await cleanup(service);
  }
});
