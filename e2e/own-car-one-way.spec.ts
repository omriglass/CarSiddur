import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

// REQ §13.206 (owner 2026-11-09, production: a one-way trip on the member's own rental was waitlisted): a waiting
// one-way trip goes on my own private car from /my ("שבץ על הרכב שלי"), and the ride leaves the car at the destination.
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-04-07"; // a Sunday
const MEMBER2 = "00000000-0000-0000-0000-000000000104";
const PRIVATE_CAR_ID = "00000000-0000-0000-0000-000000000043"; // temporary, owner = member2 (seed.sql)

test("a waiting one-way trip goes on my private car from /my", { tag: ["@request-form"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: destination } = await service.from("destinations").select("id").eq("department_id", NEVO_DEPARTMENT_ID)
    .neq("id", department!.home_destination_id).order("id").limit(1).single();
  const { data: request, error } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: MEMBER2, filed_by: MEMBER2,
    ride_type_id: "00000000-0000-0000-0000-000000000021", origin_id: department!.home_destination_id, destination_id: destination!.id,
    trip_type: "one_way", trip_shape: "one_way_to", depart_at: `2041-04-08T10:00:00+03:00`, adults: 1,
    status: "waitlisted", status_reason: "WAITLISTED_NO_CAR",
  }).select("id").single();
  if (error) throw error;

  const owner = await newSignedInPage(browser, SEEDED_USERS.member2);
  try {
    await owner.page.goto("/my");
    const row = owner.page.locator(`[data-request-id="${request!.id}"]`).locator("visible=true").first();
    await row.getByRole("button", { name: he.request.placeOnOwnCar, exact: true }).click();
    await expect.poll(async () => (await service.from("requests").select("status").eq("id", request!.id).single()).data?.status).toBe("assigned");
    const { data: links } = await service.from("ride_requests").select("rides(car_id, destination_id, status)").eq("request_id", request!.id);
    expect(links?.[0]?.rides).toMatchObject({ car_id: PRIVATE_CAR_ID, destination_id: destination!.id });
  } finally {
    await owner.context.close();
    const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", request!.id);
    await service.from("ride_requests").delete().eq("request_id", request!.id);
    for (const link of links ?? []) await service.from("rides").delete().eq("id", link.ride_id);
    await service.from("requests").delete().eq("id", request!.id);
  }
});
