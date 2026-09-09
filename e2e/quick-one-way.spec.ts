import { expect, test, type Page } from "@playwright/test";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

test.use({ actionTimeout: 15_000 });

function mainDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.getByRole("heading") });
}

async function quickFixture(week: string) {
  const service = serviceRoleClient();
  async function cleanup() {
    const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    // Retain the immutable empty publication, but do not leave an extra live week.
    await service.from("weeks").update({ phase: "published" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).not("published_version_id", "is", null);
  }
  await cleanup();
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  const { error: phaseError } = await service.from("weeks").update({ phase: "live" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  if (phaseError) throw phaseError;
  const { data: car, error: carError } = await service.from("car_seat_configs").select("car_id,cars!inner(id,name,department_id,type,status)").gte("adults", 5)
    .eq("cars.department_id", NEVO_DEPARTMENT_ID).eq("cars.type", "shared").eq("cars.status", "active").limit(1).single();
  if (carError) throw carError;
  const { data: destination, error: destinationError } = await service.from("destinations").select("id,name,travel_minutes").eq("id", "00000000-0000-0000-0000-000000000011").single();
  if (destinationError) throw destinationError;
  const { data: settings } = await service.from("department_settings").select("chauffeur_dwell_minutes").eq("department_id", NEVO_DEPARTMENT_ID).single();
  return { service, cleanup, carId: car!.car_id as string, destination: destination!, dwell: settings!.chauffeur_dwell_minutes as number };
}

async function openQuickRequest(page: Page, week: string, carId: string, minutes = 600) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await expect(column).toBeVisible();
  await column.evaluate((el, minute) => {
    const scroller = el.closest<HTMLElement>(".overflow-auto")!;
    scroller.scrollTop = Math.max(0, (minute - 360) / 1080 * el.scrollHeight - scroller.clientHeight / 2);
  }, minutes);
  const bounds = await column.boundingBox();
  if (!bounds) throw new Error("missing car column");
  await column.click({ position: { x: bounds.width / 2, y: (minutes - 360) / 1080 * bounds.height } });
  await expect(mainDialog(page)).toBeVisible();
}

async function fillPublicDetails(page: Page, destinationName: string, description: string, guestNames: string[]) {
  await page.getByPlaceholder(he.field.destination).fill(destinationName);
  await page.getByRole("option").filter({ hasText: destinationName }).first().click();
  const sheet = mainDialog(page);
  await sheet.getByLabel(he.quickRequest.rideDescription, { exact: true }).fill(description);
  // Companions/children/guest names are always visible in the shared `RequestForm` body
  // (no "more passenger details" toggle, unlike the pre-unification quick sheet).
  await sheet.getByRole("combobox", { name: he.field.companions, exact: true }).click();
  await page.getByRole("option", { name: SEEDED_USERS.admin.fullName, exact: true }).click();
  await page.keyboard.press("Escape");
  await sheet.getByLabel(he.quickRequest.guestPassengers, { exact: true }).fill(guestNames.join("\n"));
  // Seat counts are derived from named companions/children/guests (`RequestForm.tsx`), not a
  // manual stepper — 1 (self) + 1 companion + `guestNames.length` guests.
  await expect(sheet.getByText(tv("request.namedPassengerCount", { count: String(1 + 1 + guestNames.length) }))).toBeVisible();
}

for (const [index, shape] of (["one_way_to", "one_way_from"] as const).entries()) {
  test(`live quick ${shape} keeps the requested endpoint and public passenger details through a driver claim`, async ({ browser }) => {
    const week = index ? "2044-01-10" : "2044-01-03";
    const fixture = await quickFixture(week);
    const description = `E2E ${shape} community outing`;
    const guestNames = [`Guest ${shape} Alpha`, `Guest ${shape} Beta`];
    const contexts: { close: () => Promise<void> }[] = [];
    try {
      const member = await newSignedInPage(browser, SEEDED_USERS.member1);
      contexts.push(member.context);
      await openQuickRequest(member.page, week, fixture.carId);
      await fillPublicDetails(member.page, fixture.destination.name, description, guestNames);
      await member.page.getByRole("radio", { name: shape === "one_way_to" ? he.request.tripShapeOneWayTo : he.request.tripShapeOneWayFrom, exact: true }).click();
      const sheet = mainDialog(member.page);
      if (shape === "one_way_from") {
        await expect(sheet.getByLabel(he.field.depart, { exact: true })).toHaveCount(0);
        await expect(sheet.getByLabel(he.field.return, { exact: true })).toHaveValue("10:00");
      }
      await sheet.getByRole("button", { name: he.quickRequest.submitOneWay, exact: true }).click();
      await expect(sheet).not.toBeVisible();
      await expect(member.page.locator('[data-needs-driver="true"]')).toHaveCount(1);
      const { data: request, error: requestError } = await fixture.service.from("requests").select("id,trip_shape,depart_at,return_at,adults,ride_description,guest_passenger_names")
        .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).single();
      if (requestError) throw requestError;
      expect(request!.trip_shape).toBe(shape);
      expect(request!.ride_description).toBe(description);
      expect(request!.guest_passenger_names).toEqual(guestNames);
      expect(request!.adults).toBe(4);
      expect(shape === "one_way_to" ? request!.return_at : request!.depart_at).toBeNull();
      expect(Date.parse(shape === "one_way_to" ? request!.depart_at : request!.return_at)).toBe(Date.parse(`${week}T10:00:00+02:00`));
      const { data: companions } = await fixture.service.from("request_companions").select("profile_id").eq("request_id", request!.id);
      expect(companions).toEqual([{ profile_id: "00000000-0000-0000-0000-000000000101" }]);
      const { data: guestsWithAccounts } = await fixture.service.from("profiles").select("id").in("full_name", guestNames);
      expect(guestsWithAccounts).toEqual([]);
      const { data: ride, error: rideError } = await fixture.service.from("rides").select("id,car_id,driver_id,needs_driver,starts_at,ends_at").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).single();
      if (rideError) throw rideError;
      expect(ride!.car_id).toBe(fixture.carId);
      expect(ride!.driver_id).toBeNull();
      expect(ride!.needs_driver).toBe(true);
      expect(Date.parse(ride!.ends_at) - Date.parse(ride!.starts_at)).toBe(Math.ceil((2 * fixture.destination.travel_minutes + fixture.dwell) / 15) * 15 * 60000);
      expect(Date.parse(shape === "one_way_to" ? ride!.starts_at : ride!.ends_at)).toBe(Date.parse(`${week}T10:00:00+02:00`));

      const coordinator = await newSignedInPage(browser, SEEDED_USERS.sadran);
      contexts.push(coordinator.context);
      await coordinator.page.setViewportSize({ width: 1440, height: 1000 });
      await coordinator.page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`);
      const boardRide = coordinator.page.locator(`button[data-ride-id="${ride!.id}"]:visible`);
      await expect(boardRide).toHaveAttribute("data-needs-driver", "true");
      await expect(boardRide).toContainText(description);

      const volunteer = await newSignedInPage(browser, SEEDED_USERS.member2);
      contexts.push(volunteer.context);
      await volunteer.page.setViewportSize({ width: 390, height: 844 });
      await volunteer.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
      await volunteer.page.getByRole("button").filter({ hasText: description }).click();
      const detail = mainDialog(volunteer.page);
      await expect(detail).toContainText(description);
      await expect(detail).toContainText(SEEDED_USERS.admin.fullName);
      for (const name of guestNames) await expect(detail).toContainText(name);
      await volunteer.page.keyboard.press("Escape");
      await volunteer.page.reload();
      await volunteer.page.getByRole("button").filter({ hasText: description }).click();
      await expect(mainDialog(volunteer.page)).toContainText(guestNames[1]!);
      await mainDialog(volunteer.page).getByRole("button", { name: he.rideCoordination.volunteer, exact: true }).click();
      await expect(mainDialog(volunteer.page)).not.toBeVisible();
      const { data: claimed } = await fixture.service.from("rides").select("driver_id,needs_driver").eq("id", ride!.id).single();
      expect(claimed).toEqual({ driver_id: "00000000-0000-0000-0000-000000000104", needs_driver: false });
      await volunteer.page.reload();
      await volunteer.page.getByRole("button").filter({ hasText: description }).click();
      for (const name of guestNames) await expect(mainDialog(volunteer.page)).toContainText(name);
    } finally {
      for (const context of contexts) await context.close().catch(() => undefined);
      await fixture.cleanup();
    }
  });
}

test("quick round-trip metadata persists when the member reopens and saves the ride", async ({ browser }) => {
  const week = "2044-01-17";
  const fixture = await quickFixture(week);
  const member = await newSignedInPage(browser, SEEDED_USERS.member1);
  const description = "E2E roundtrip public description";
  const guestNames = ["Guest roundtrip Alpha"];
  try {
    await openQuickRequest(member.page, week, fixture.carId);
    await fillPublicDetails(member.page, fixture.destination.name, description, guestNames);
    await mainDialog(member.page).getByRole("button", { name: he.quickRequest.submit, exact: true }).click();
    await expect(mainDialog(member.page)).not.toBeVisible();
    const { data: request, error } = await fixture.service.from("requests").select("id,ride_description,guest_passenger_names,adults,status").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).single();
    if (error) throw error;
    expect(request!.status).toBe("assigned");
    expect(request!.adults).toBe(3);
    await member.page.reload();
    const { data: ride } = await fixture.service.from("rides").select("id,driver_id,needs_driver").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).single();
    expect(ride!.driver_id).toBe("00000000-0000-0000-0000-000000000103");
    expect(ride!.needs_driver).toBe(false);
    await member.page.locator(`[data-ride-id="${ride!.id}"]:visible`).click();
    await expect(mainDialog(member.page)).toContainText(description);
    await expect(mainDialog(member.page)).toContainText(guestNames[0]!);
    // Editing the owned live ride must retain its request's public metadata.
    await mainDialog(member.page).getByLabel(he.field.return, { exact: true }).fill("12:15");
    await mainDialog(member.page).getByRole("button", { name: he.common.save, exact: true }).click();
    await expect(mainDialog(member.page)).not.toBeVisible();
    const { data: saved } = await fixture.service.from("requests").select("ride_description,guest_passenger_names,adults").eq("id", request!.id).single();
    expect(saved).toEqual({ ride_description: description, guest_passenger_names: guestNames, adults: 3 });
    await member.page.reload();
    await member.page.locator(`[data-ride-id="${ride!.id}"]:visible`).click();
    await expect(mainDialog(member.page)).toContainText(description);
    await expect(mainDialog(member.page)).toContainText(guestNames[0]!);
  } finally {
    await member.context.close().catch(() => undefined);
    await fixture.cleanup();
  }
});
