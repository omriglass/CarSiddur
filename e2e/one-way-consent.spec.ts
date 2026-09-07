import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

test.use({ actionTimeout: 15_000 });

test("combined one-way consent preserves an orphaned passenger and lets a member volunteer", async ({ browser }) => {
  const service = serviceRoleClient();
  const week = "2041-01-13";
  const admin = await publishedFixtureWeek(week);
  const memberIds = ["00000000-0000-0000-0000-000000000103", "00000000-0000-0000-0000-000000000104"];
  const requestIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  let rideId: string | undefined;
  async function cleanupFixture() {
    await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    const { data: fixtureRides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (fixtureRides?.length) await service.from("ride_requests").delete().in("ride_id", fixtureRides.map((r) => r.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  await cleanupFixture();
  try {
    const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
    const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1).single();
    for (const [index, requester] of memberIds.entries()) {
      const { data, error } = await service.from("requests").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week,
        requester_id: requester, filed_by: requester, ride_type_id: "00000000-0000-0000-0000-000000000021",
        destination_text: index ? "E2E passenger Train" : "E2E host Pardes Hana", trip_shape: index ? "one_way_to" : "round_trip",
        one_way_car_mode: index ? "passenger" : null, depart_at: `${week}T07:${index ? "00" : "15"}:00+02:00`,
        return_at: index ? null : `${week}T10:00:00+02:00`, status: index ? "waitlisted" : "assigned" }).select("id").single();
      if (error) throw error;
      requestIds.push(data!.id);
    }
    const { data: ride, error: rideError } = await service.from("rides").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week,
      car_id: car!.id, driver_id: memberIds[0], created_by: memberIds[0], origin_id: department!.home_destination_id, destination_id: department!.home_destination_id,
      starts_at: `${week}T07:15:00+02:00`, ends_at: `${week}T10:00:00+02:00`, blocked_until: `${week}T10:30:00+02:00`, status: "confirmed" }).select("id").single();
    if (rideError) throw rideError;
    rideId = ride!.id;
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: rideId, request_id: requestIds[0], role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;
    const { data: proposalId, error: proposalError } = await admin.rpc("create_proposal", {
      p_request_id: requestIds[1], p_ride_id: rideId, p_type: "merge", p_reason_he: "E2E combined ride 07:00–10:00",
      p_payload: { ride_id: rideId, starts_at: `${week}T07:00:00+02:00`, ends_at: `${week}T10:00:00+02:00`,
        legs: [{ ride_id: rideId, role: "passenger", leg: "out", car_mode: "passenger" }] },
      p_party_profile_ids: [], p_created_via: "sadran",
    });
    if (proposalError) throw proposalError;
    const { data: sent, error: sendError } = await admin.rpc("send_proposal", { p_proposal_id: proposalId, p_sent_via: [] });
    if (sendError) throw sendError;
    expect(Object.keys(sent.party_tokens).sort()).toEqual([...memberIds].sort());

    const driver = await newSignedInPage(browser, SEEDED_USERS.member1);
    const passenger = await newSignedInPage(browser, SEEDED_USERS.member2);
    contexts.push(driver.context, passenger.context);
    await driver.page.goto(`/p/${sent.party_tokens[memberIds[0]!]}`);
    await expect(driver.page.getByText(he.rideCoordination.combinedWindow)).toBeVisible();
    await expect(driver.page.getByText("07:00 → 10:00")).toBeVisible();
    await driver.page.getByRole("button", { name: he.action.acceptProposal, exact: true }).click();
    const { data: before } = await service.from("rides").select("starts_at").eq("id", rideId).single();
    expect(new Date(before!.starts_at).toISOString()).toBe(`${week}T05:15:00.000Z`);
    await passenger.page.goto(`/p/${sent.party_tokens[memberIds[1]!]}`);
    await passenger.page.getByRole("button", { name: he.action.acceptProposal, exact: true }).click();
    await expect.poll(async () => (await service.from("proposals").select("status").eq("id", proposalId).single()).data?.status).toBe("applied");
    const { data: combined } = await service.from("rides").select("starts_at").eq("id", rideId).single();
    expect(new Date(combined!.starts_at).toISOString()).toBe(`${week}T05:00:00.000Z`);

    const coordinator = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(coordinator.context);
    await coordinator.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`);
    await coordinator.page.getByRole("button", { name: he.deviations.title, exact: true }).click();
    const deviation = coordinator.page.locator(`[data-request-deviation="${requestIds[0]}"]`);
    const tripSummary = deviation.locator("[data-trip-summary]");
    await expect(tripSummary).toContainText(SEEDED_USERS.member1.fullName);
    await expect(tripSummary).toContainText("13/1/2041");
    await expect(tripSummary).toContainText(he.days.long[0]!);
    await expect(tripSummary).toContainText("07:15–10:00");
    const { data: rideType } = await service.from("ride_types").select("name_he").eq("id", "00000000-0000-0000-0000-000000000021").single();
    await expect(tripSummary).toContainText(rideType!.name_he);
    await expect(deviation).toContainText("07:15");
    await expect(deviation).toContainText("07:00");
    await coordinator.page.keyboard.press("Escape");

    await driver.page.goto("/requests");
    const ownCard = driver.page.locator(`[data-request-id="${requestIds[0]}"]`);
    await ownCard.getByRole("button", { name: he.requestsList.cancelRide, exact: true }).click();
    await driver.page.getByRole("dialog").getByRole("button", { name: he.requestsList.cancelRide, exact: true }).click();
    await expect(driver.page.getByRole("dialog")).not.toBeVisible();
    const { data: orphan } = await service.from("rides").select("needs_driver,driver_id,status").eq("id", rideId).single();
    expect(orphan!.needs_driver).toBe(true);
    expect(orphan!.driver_id).toBeNull();
    expect(orphan!.status).not.toBe("cancelled");
    const { data: surviving } = await service.from("ride_requests").select("request_id").eq("ride_id", rideId);
    expect(surviving).toEqual([{ request_id: requestIds[1] }]);

    await passenger.page.setViewportSize({ width: 390, height: 844 });
    await passenger.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
    await passenger.page.getByRole("button").filter({ hasText: he.rideCoordination.missingDriver }).click();
    await passenger.page.getByRole("dialog").getByRole("button", { name: he.rideCoordination.volunteer, exact: true }).click();
    await expect(passenger.page.getByRole("dialog")).not.toBeVisible();
    await expect(passenger.page.getByText(he.rideCoordination.missingDriver)).toHaveCount(0);
    const { data: claimed } = await service.from("rides").select("needs_driver,driver_id").eq("id", rideId).single();
    expect(claimed).toEqual({ needs_driver: false, driver_id: memberIds[1] });
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await admin.auth.signOut();
    await cleanupFixture();
    // The empty immutable publication is removed by the next disposable-stack reset.
  }
});
