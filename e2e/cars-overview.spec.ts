import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * REQ item 150 (e): the all-cars dashboard at /cars. Admins and the department's car administrators see one row per
 * shared, non-retired car (tyre fill, wash, replacement flag, status); other members do not. Does not reset the
 * database (run with E2E_SKIP_RESET=1): it adds two care events with a marker note and removes them afterwards.
 */

const service = serviceRoleClient();
const SHARED_CAR_ID = "00000000-0000-0000-0000-000000000041"; // shared, no responsible person (seed.sql)
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const MEMBER2_ID = "00000000-0000-0000-0000-000000000104";
const MARKER = "e2e-cars-overview";

async function setCarAdmin(value: boolean) {
  const { error } = await service
    .from("department_members")
    .update({ is_car_admin: value })
    .eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("profile_id", MEMBER2_ID);
  if (error) throw error;
}

test.afterAll(async () => {
  await service.from("car_care_events").delete().eq("note", MARKER);
  await setCarAdmin(false);
});

test("a member is refused; admin and a car admin see the shared cars with care columns", { tag: ["@car-admin"] }, async ({ browser }) => {
  test.setTimeout(120_000);
  await service.from("car_care_events").delete().eq("note", MARKER);
  const care = await service.from("car_care_events").insert([
    {
      department_id: NEVO_DEPARTMENT_ID,
      car_id: SHARED_CAR_ID,
      kind: "tire_fill",
      tires: { front_left: "ok", front_right: "very_low", rear_left: "low", rear_right: "ok", spare: "unchecked" },
      note: MARKER,
      reported_by: MEMBER1_ID,
    },
    { department_id: NEVO_DEPARTMENT_ID, car_id: SHARED_CAR_ID, kind: "wash", note: MARKER, reported_by: MEMBER1_ID },
  ]);
  if (care.error) throw care.error;

  const member = await newSignedInPage(browser, SEEDED_USERS.member2);
  await member.page.setViewportSize({ width: 390, height: 844 });
  try {
    await test.step("a plain member has no entry point and is refused", async () => {
      await member.page.goto(paths.cars());
      await expect(member.page.getByText(he.carsOverview.notAuthorized)).toBeVisible();
      await expect(member.page.getByTestId("nav-cars-overview")).toHaveCount(0);
    });

    await test.step("a car admin (not Sadran/admin) finds the entry and sees stacked cards on a phone", async () => {
      await setCarAdmin(true);
      await member.page.goto("/my");
      await member.page.getByTestId("nav-cars-overview").click();
      await expect(member.page).toHaveURL(/\/cars$/);
      const row = member.page.getByTestId(`car-overview-row-${SHARED_CAR_ID}`);
      await expect(row).toBeVisible();
      await expect(row.getByTestId("car-overview-tires").locator("[data-tire-worst]")).toHaveAttribute("data-tire-worst", "very_low");
      await expect(row.getByTestId("car-overview-wash")).not.toContainText(he.carsOverview.neverDone);
      await expect(row.getByTestId("car-overview-checklist")).toContainText(he.carsOverview.noData);
      const overflow = await member.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await row.click();
      await expect(member.page).toHaveURL(new RegExp(`/cars/${SHARED_CAR_ID}$`));
    });
  } finally {
    await member.context.close();
  }

  const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  try {
    await test.step("admin on a computer sees the same row in the grid", async () => {
      await admin.page.goto(paths.cars());
      await expect(admin.page.getByTestId(`car-overview-row-${SHARED_CAR_ID}`)).toBeVisible();
      await expect(admin.page.getByTestId(`car-overview-row-${SHARED_CAR_ID}`).getByTestId("car-overview-km")).toBeVisible();
    });
  } finally {
    await admin.context.close();
  }
});
