import { expect, test, type Page } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * "Be back on time" (!) — REQ §13.108 f (commit aea7f9b, `v_ride_car_neighbours`): on a ride the member
 * drives or requested, when the next ride on the same shared car starts no more than the week's turnaround
 * (min 30 minutes) after it ends, /my and the siddur ride sheet show a "!" naming who takes the car next and
 * when; the next ride's driver sees the mirror note. A 2-hour gap shows nothing.
 */
test.use({ actionTimeout: 15_000 });

const WEEK = "2041-02-03"; // a Sunday; published empty by `publishedFixtureWeek`
const MEMBER1 = { id: "00000000-0000-0000-0000-000000000103", name: SEEDED_USERS.member1.fullName };
const MEMBER2 = { id: "00000000-0000-0000-0000-000000000104", name: SEEDED_USERS.member2.fullName };
const at = (time: string) => `${WEEK}T${time}:00+02:00`;

type Service = ReturnType<typeof serviceRoleClient>;

async function cleanup(service: Service) {
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

/** Two confirmed rides on one shared car: member1 10:00-11:00, member2 starting `gapMinutes` after the first ends. */
async function fixture(service: Service, gapMinutes: number) {
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1).single();
  const secondStart = new Date(Date.parse(at("11:00")) + gapMinutes * 60_000);
  const secondEnd = new Date(secondStart.getTime() + 60 * 60_000);
  const hhmm = (date: Date) => date.toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });
  const plan = [
    { member: MEMBER1, start: at("10:00"), end: at("11:00"), blocked: at("11:30"), label: "10:00", endLabel: "11:00" },
    { member: MEMBER2, start: secondStart.toISOString(), end: secondEnd.toISOString(), blocked: new Date(secondEnd.getTime() + 30 * 60_000).toISOString(), label: hhmm(secondStart), endLabel: hhmm(secondEnd) },
  ];
  const rideIds: string[] = [];
  for (const [index, row] of plan.entries()) {
    const { data: request, error: requestError } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: row.member.id, filed_by: row.member.id,
      ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: `E2E handover ${index}`,
      trip_shape: "round_trip", depart_at: row.start, return_at: row.end, status: "assigned",
    }).select("id").single();
    if (requestError) throw requestError;
    const { data: ride, error: rideError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: car!.id, driver_id: row.member.id, created_by: row.member.id,
      starts_at: row.start, ends_at: row.end, blocked_until: row.blocked,
      origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed",
    }).select("id").single();
    if (rideError) throw rideError;
    rideIds.push(ride!.id);
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: request!.id, role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;
  }
  return { rideIds, secondLabel: plan[1]!.label, firstEndLabel: plan[0]!.endLabel };
}

/** Opens `url` and waits for the neighbours view (the note's one data source) before the caller asserts absence. */
async function gotoAfterNeighbours(page: Page, url: string, open?: () => Promise<void>) {
  const neighbours = page.waitForResponse((response) => response.url().includes("v_ride_car_neighbours") && response.ok());
  await page.goto(url);
  await open?.();
  await neighbours;
}

test.describe("be back on time (!) note", { tag: ["@siddur"] }, () => {
  let service: Service;

  test.beforeEach(async () => {
    service = serviceRoleClient();
    const admin = await publishedFixtureWeek(WEEK);
    await admin.auth.signOut();
    await cleanup(service);
  });

  test.afterEach(async () => {
    await cleanup(service);
  });

  test("a tight handover shows the driver the note and the next driver its mirror, on /my and in the ride sheet", async ({ browser }) => {
    test.slow();
    const { rideIds, secondLabel, firstEndLabel } = await fixture(service, 30);
    const returnBy = tv("carHandover.returnByRide", { name: MEMBER2.name, time: secondLabel });
    const arrivesFrom = tv("carHandover.arrivesFromRide", { name: MEMBER1.name, time: firstEndLabel });
    const contexts: { close: () => Promise<void> }[] = [];
    try {
      const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
      contexts.push(member1.context);
      const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
      contexts.push(member2.context);

      await test.step("member1 sees the return-on-time note on /my naming member2 and the time", async () => {
        await member1.page.goto("/my");
        const note = member1.page.getByTestId("car-handover-notice").filter({ hasText: returnBy }).first();
        await expect(note).toBeVisible();
        await expect(note.getByRole("img", { name: he.carHandover.alertLabel })).toHaveText("!");
        await expect(member1.page.getByTestId("car-handover-notice").filter({ hasText: arrivesFrom })).toHaveCount(0);
      });

      await test.step("member1 sees the same note in the siddur ride sheet", async () => {
        await member1.page.setViewportSize({ width: 1440, height: 900 });
        await member1.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
        await member1.page.locator(`[data-ride-id="${rideIds[0]}"]:visible`).click();
        const sheet = member1.page.getByRole("dialog");
        await expect(sheet.getByTestId("car-handover-notice")).toContainText(returnBy);
      });

      await test.step("member2 sees the mirror note on /my and in the ride sheet", async () => {
        await member2.page.goto("/my");
        await expect(member2.page.getByTestId("car-handover-notice").filter({ hasText: arrivesFrom }).first()).toBeVisible();
        await expect(member2.page.getByTestId("car-handover-notice").filter({ hasText: returnBy })).toHaveCount(0);
        await member2.page.setViewportSize({ width: 1440, height: 900 });
        await member2.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`);
        await member2.page.locator(`[data-ride-id="${rideIds[1]}"]:visible`).click();
        await expect(member2.page.getByRole("dialog").getByTestId("car-handover-notice")).toContainText(arrivesFrom);
      });
    } finally {
      for (const context of contexts) await context.close().catch(() => undefined);
    }
  });

  test("a 2-hour gap shows no note", async ({ browser }) => {
    test.slow();
    const { rideIds, secondLabel, firstEndLabel } = await fixture(service, 120);
    const returnBy = tv("carHandover.returnByRide", { name: MEMBER2.name, time: secondLabel });
    const arrivesFrom = tv("carHandover.arrivesFromRide", { name: MEMBER1.name, time: firstEndLabel });
    const contexts: { close: () => Promise<void> }[] = [];
    try {
      const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
      contexts.push(member1.context);
      const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
      contexts.push(member2.context);

      await test.step("no note on /my for either member", async () => {
        await gotoAfterNeighbours(member1.page, "/my");
        await expect(member1.page.getByTestId("car-handover-notice").filter({ hasText: returnBy })).toHaveCount(0);
        await gotoAfterNeighbours(member2.page, "/my");
        await expect(member2.page.getByTestId("car-handover-notice").filter({ hasText: arrivesFrom })).toHaveCount(0);
      });

      await test.step("no note in the ride sheet", async () => {
        await member1.page.setViewportSize({ width: 1440, height: 900 });
        await gotoAfterNeighbours(member1.page, `/siddur/${NEVO_DEPARTMENT_ID}/${WEEK}`, async () => {
          await member1.page.locator(`[data-ride-id="${rideIds[0]}"]:visible`).click();
        });
        const sheet = member1.page.getByRole("dialog");
        await expect(sheet).toBeVisible();
        await expect(sheet.getByTestId("car-handover-notice")).toHaveCount(0);
      });
    } finally {
      for (const context of contexts) await context.close().catch(() => undefined);
    }
  });
});
