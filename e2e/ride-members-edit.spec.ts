import { expect, test, type Locator, type Page } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, openRideDetails, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// REQ §13.179: member2 rides along on member1's ride. The sheet calls it a shared ride and "עריכה" opens member1's
// trip; member2 stretches the ride on the grid, is asked "דיברת עם חבר ראשון?" and member1 gets one notice.
test.use({ actionTimeout: 15_000 });

/** Drags from the middle of `handle` downwards until the drag preview reads `preview`, then drops. */
async function dragUntil(page: Page, handle: Locator, preview: string) {
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  let y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 0; step < 400; step += 1) {
    y += 2;
    await page.mouse.move(x, y);
    if (((await page.locator("[data-drag-preview]").textContent().catch(() => "")) ?? "").includes(preview)) break;
  }
  await expect(page.locator("[data-drag-preview]")).toContainText(preview);
  await page.mouse.up();
}

test("a guest on a shared ride edits the ride itself, after agreeing with its driver", { tag: ["@siddur"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const week = FIXTURE_WEEKS.rideMembersEdit;
  const day = dayOfWeek(week, 2);
  await removeWeek(service, week);
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const carId = await sharedCarIdByName(service, "יונדאי 1");
    const hostRequest = await insertRequest(service, day, {
      week, requester: PROFILE_IDS.member1, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
    });
    const guestRequest = await insertRequest(service, day, {
      week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "merged",
    });
    const { data: ride, error } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: PROFILE_IDS.member1, created_by: PROFILE_IDS.member1,
      starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
      origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
    }).select("id").single();
    if (error) throw error;
    await service.from("ride_requests").insert([
      { ride_id: ride.id, request_id: hostRequest, role: "driver", leg: "both", car_mode: "keep" },
      { ride_id: ride.id, request_id: guestRequest, role: "passenger", leg: "both", car_mode: "passenger" },
    ]);
    await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member1).eq("event", "ride_edited");

    const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
    contexts.push(member2.context);
    const page = member2.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    const openSiddurDay = async () => {
      await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week }));
      await page.getByRole("radio", { name: new RegExp(`${Number(day.slice(8))}\\.${Number(day.slice(5, 7))}$`) }).click();
    };
    await openSiddurDay();
    const block = page.locator(`[data-ride-id="${ride.id}"]:visible`);

    await test.step("the sheet names the shared ride and its edit opens the driver's trip", async () => {
      await openRideDetails(page, block);
      await expect(page.getByTestId("ride-merged-of")).toHaveText(
        tv("rideDetail.mergedOf", { names: `${SEEDED_USERS.member1.fullName}, ${SEEDED_USERS.member2.fullName}` }));
      await page.getByTestId("ride-edit-request").click();
      await expect(page).toHaveURL(new RegExp(`/requests/${hostRequest}/edit`));
    });

    await test.step("stretching the ride asks about member1, then saves and tells them once", async () => {
      await openSiddurDay();
      await page.getByTestId("edit-mode-button").locator("visible=true").click();
      await dragUntil(page, block.locator(".bottom-0"), "10:00–12:30");
      const ask = page.getByRole("dialog").filter({ hasText: he.rideMoveAgreement.confirm });
      await expect(ask).toContainText(tv("rideMoveAgreement.title", { names: SEEDED_USERS.member1.fullName }));
      await ask.getByRole("button", { name: he.rideMoveAgreement.confirm, exact: true }).click();
      await expect.poll(async () => new Date((await service.from("rides").select("ends_at").eq("id", ride.id).single()).data!.ends_at).toISOString())
        .toBe(new Date(winterAt(day, "12:30")).toISOString());
      await expect.poll(async () => (await service.from("notifications").select("id").eq("recipient_id", PROFILE_IDS.member1)
        .eq("event", "ride_edited").eq("data->>ride_id", ride.id)).data?.length).toBe(1);
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await service.from("notifications").delete().eq("event", "ride_edited").eq("week_start", week);
    await removeWeek(service, week);
  }
});
