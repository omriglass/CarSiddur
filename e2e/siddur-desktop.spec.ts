import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// REQ §13.111 (b), UX_FLOWS "member siddur": the published siddur on a computer (1280 px) has the same week choice as the
// phone — this week / next week / archive, not a list of weeks — and shows every car's name in the column headers
// without making the page scroll sideways, however many cars the department has.
test.use({ viewport: { width: 1280, height: 800 } });

test.describe("siddur on a computer", { tag: ["@siddur"] }, () => {
  test.beforeEach(async ({ page }) => { await signIn(page, SEEDED_USERS.member1); });

  test("the title is the week switcher: this week, next week, archive", async ({ page }) => {
    const liveWeek = await getWeekStart("live");
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeek }));
    const switcher = page.getByTestId("siddur-week-switcher-desktop");
    await expect(switcher).toBeVisible();
    await expect(switcher).toContainText(he.siddur.thisWeek);
    await switcher.click();
    await expect(page.getByTestId("siddur-week-option-this")).toContainText(he.siddur.thisWeek);
    await expect(page.getByTestId("siddur-week-option-next")).toContainText(he.siddur.nextWeek);
    await expect(page.getByTestId("siddur-week-option-archive")).toContainText(he.siddur.archive);

    await page.getByTestId("siddur-week-option-archive").click();
    await expect(page).toHaveURL(new RegExp(`/siddur/${NEVO_DEPARTMENT_ID}/archive$`));
  });

  test("every car name is visible and the page does not scroll sideways, even with many cars", async ({ page }) => {
    test.slow();
    const service = serviceRoleClient();
    const liveWeek = await getWeekStart("live");
    const names = Array.from({ length: 6 }, (_, index) => `E2E רכב עם שם ארוך במיוחד מספר ${index + 1}`);
    const { data: cars, error } = await service.from("cars").insert(names.map((name, index) => ({
      department_id: NEVO_DEPARTMENT_ID, name, license_plate: `E2E-77-${index + 1}`, type: "shared", status: "active",
    }))).select("id");
    if (error) throw error;
    const carIds = (cars ?? []).map((car) => car.id as string);
    try {
      const { error: seatError } = await service.from("car_seat_configs").insert(carIds.map((carId) => ({ car_id: carId, adults: 5, child_seats: 0, boosters: 0 })));
      if (seatError) throw seatError;

      await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeek }));
      await expect(page.locator(`[data-car-col-id="${carIds[0]}"]`)).toBeVisible();
      for (const name of names) {
        await expect(page.getByTestId("week-grid-car-name").filter({ hasText: name }).first()).toBeVisible();
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    } finally {
      await service.from("car_seat_configs").delete().in("car_id", carIds);
      await service.from("cars").delete().in("id", carIds);
    }
  });
});
