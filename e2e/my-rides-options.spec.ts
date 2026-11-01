import { expect, test, type Page } from "@playwright/test";

import { paths } from "../src/app/routes";
import { tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// REQ §13.177 (c, d) (owner 2026-11-01): on "my rides", what I filed for someone else and my children's other parent's
// rides are hidden until their eye-menu option is on; shown, neither is painted as mine (purple) — the filed one reads
// "הוגשה עבור X", the other parent's "נסיעה של X". The siddur paints the filed ride as not mine either.
test.use({ viewport: { width: 390, height: 844 } });

async function toggle(page: Page, testId: string) {
  await page.getByTestId("my-display-menu-trigger").click({ timeout: 10_000 });
  await page.getByTestId(testId).click({ timeout: 10_000 });
  await expect(page.getByTestId(testId)).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(testId)).toBeHidden();
}

test("rides I filed for others and my co-parent's rides wait behind their options", { tag: ["@my-week"] }, async ({ page }) => {
  test.slow();
  const service = serviceRoleClient();
  const week = FIXTURE_WEEKS.myRidesOptions;
  await removeWeek(service, week, { keepWeek: true }); // a timed-out earlier run never reached its cleanup
  await service.from("children").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("full_name", "E2E ילד משותף");
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  let childId: string | undefined;
  try {
    const carId = await sharedCarIdByName(service, "יונדאי 1");
    const rideFor = async (day: string, requestId: string) => {
      const { data, error } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: PROFILE_IDS.member2, created_by: PROFILE_IDS.member2,
        starts_at: winterAt(day, "10:00"), ends_at: winterAt(day, "12:00"), blocked_until: winterAt(day, "12:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id").single();
      if (error) throw error;
      await service.from("ride_requests").insert({ ride_id: data.id, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
      return data.id as string;
    };
    // Tuesday: member1 filed member2's trip; Wednesday: member2's own trip — member2 is the other parent of member1's child
    const tuesday = dayOfWeek(week, 2);
    const filed = await insertRequest(service, tuesday, { week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned",
      extra: { filed_by: PROFILE_IDS.member1 } });
    const filedRide = await rideFor(tuesday, filed);
    const wednesday = dayOfWeek(week, 3);
    const coParent = await insertRequest(service, wednesday, { week, requester: PROFILE_IDS.member2, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id, status: "assigned" });
    await rideFor(wednesday, coParent);
    const { data: child, error: childError } = await service.from("children").insert({ department_id: NEVO_DEPARTMENT_ID, full_name: "E2E ילד משותף", birth_year: 2036 }).select("id").single();
    if (childError) throw childError;
    childId = child.id as string;
    await service.from("child_guardians").insert([{ child_id: childId, profile_id: PROFILE_IDS.member1 }, { child_id: childId, profile_id: PROFILE_IDS.member2 }]);

    await signIn(page, SEEDED_USERS.member1);
    const filedLine = page.getByText(tv("request.filedFor", { name: SEEDED_USERS.member2.fullName }));
    const coParentLine = page.getByText(tv("myWeek.kidRideOf", { name: SEEDED_USERS.member2.fullName }));

    await test.step("hidden by default; each option shows its own", async () => {
      await page.goto(paths.my());
      await expect(page.getByTestId("my-display-menu-trigger")).toBeVisible({ timeout: 15_000 });
      await expect(filedLine).toHaveCount(0);
      await expect(coParentLine).toHaveCount(0);
      await toggle(page, "my-show-filed-for-others");
      await expect(filedLine.first()).toBeVisible({ timeout: 15_000 });
      await expect(coParentLine).toHaveCount(0);
      await toggle(page, "my-show-co-parent-rides");
      await expect(coParentLine.first()).toBeVisible({ timeout: 15_000 });
    });

    await test.step("the week view draws the filed ride muted, not as mine", async () => {
      await page.goto(`${paths.my()}?view=week&week=${week}`);
      const block = page.locator(`[data-ride-id="ride:${filedRide}"]:visible`).first();
      await expect(block).toContainText(tv("request.filedFor", { name: SEEDED_USERS.member2.fullName }));
      await expect(block).not.toHaveAttribute("data-my-ride", /.*/);
    });

    await test.step("the siddur does not paint it as mine", async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week }));
      await page.getByRole("radio", { name: new RegExp(`${Number(tuesday.slice(8))}\\.${Number(tuesday.slice(5, 7))}$`) }).click();
      const block = page.locator(`[data-ride-id="${filedRide}"]:visible`).first();
      await expect(block).toBeVisible({ timeout: 15_000 });
      await expect(block).not.toHaveAttribute("data-my-ride", /.*/);
    });
  } finally {
    if (childId) {
      await service.from("child_guardians").delete().eq("child_id", childId);
      await service.from("children").delete().eq("id", childId);
    }
    await removeWeek(service, week);
  }
});
