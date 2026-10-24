import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

/**
 * REQ item 150 (a) + (c): the admin sets "מנהל/ת רכבים" on a membership; a car admin manages the department's
 * shared cars (kilometrage correction) but /my lists only the cars they are personally responsible for;
 * members log kilometrage readings that may never go down.
 */

const service = serviceRoleClient();
const SHARED_CAR_ID = "00000000-0000-0000-0000-000000000041"; // shared, no responsible person (seed.sql)
const RESPONSIBLE_CAR_ID = "00000000-0000-0000-0000-000000000040"; // shared, responsible = member1 (seed.sql)
const MEMBER2_ID = "00000000-0000-0000-0000-000000000104";

async function carAdminFlag(): Promise<boolean> {
  const { data, error } = await service
    .from("department_members")
    .select("is_car_admin")
    .eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("profile_id", MEMBER2_ID)
    .single();
  if (error) throw error;
  return data.is_car_admin as boolean;
}

test("admin sets car admin; car admin corrects kilometrage but /my stays personal; readings never go down", { tag: ["@car-admin"] }, async ({ page, browser }) => {
  test.setTimeout(120_000);
  try {
    await test.step("admin switches 'מנהל/ת רכבים' on for member2", async () => {
      await signIn(page, SEEDED_USERS.admin);
      await page.goto("/admin/members");
      const row = page.getByRole("row").filter({ hasText: "member2@nevo.local" });
      await row.getByRole("button").first().click();
      const editor = page.getByRole("dialog");
      const toggle = editor.getByTestId(`member-car-admin-${NEVO_DEPARTMENT_ID}`);
      await expect(toggle).not.toBeChecked();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect.poll(carAdminFlag).toBe(true);
    });

    const { context, page: member2 } = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await test.step("/my lists no cars for a car admin who is responsible for none", async () => {
        await member2.waitForLoadState("networkidle");
        await expect(member2.getByRole("heading", { name: he.carPage.homeMyCarsTitle })).toHaveCount(0);
      });

      await test.step("kilometrage reading: saved, then a lower one is refused", async () => {
        await member2.goto(paths.car(SHARED_CAR_ID));
        const reportDialog = member2.getByRole("dialog");
        await member2.getByTestId("car-name-report-trigger").click();
        await reportDialog.getByRole("button", { name: he.carCare.homeKilometrageTitle }).click();
        await expect(reportDialog.getByTestId("car-km-last")).toContainText(he.carCare.kmNone);
        await reportDialog.getByTestId("car-km-input").fill("12000");
        await reportDialog.getByRole("button", { name: he.carCare.kmSave }).click();
        await expect(member2.getByText(he.carCare.kmSaved)).toBeVisible();
        await expect(member2.getByTestId("car-current-km")).toContainText("12,000");

        await member2.getByTestId("car-name-report-trigger").click();
        await reportDialog.getByRole("button", { name: he.carCare.homeKilometrageTitle }).click();
        await expect(reportDialog.getByTestId("car-km-last")).toContainText("12,000");
        await reportDialog.getByTestId("car-km-input").fill("11000");
        await reportDialog.getByRole("button", { name: he.carCare.kmSave }).click();
        await expect(member2.getByText(he.errors.kilometrageLowerThanLast)).toBeVisible();
        await member2.keyboard.press("Escape");
      });

      await test.step("the car admin corrects the kilometrage to a lower value", async () => {
        await member2.getByTestId("car-km-correct").click();
        const dialog = member2.getByRole("dialog");
        await dialog.getByTestId("car-km-correct-input").fill("11500");
        await dialog.getByRole("button", { name: he.carPage.kmCorrectSubmit }).click();
        await expect(member2.getByText(he.carPage.kmCorrected)).toBeVisible();
        await expect(member2.getByTestId("car-current-km")).toContainText("11,500");
        await member2.getByRole("tab", { name: he.carPage.tabHistory }).click();
        await expect(member2.getByTestId("car-history-km")).toHaveCount(2);
        await expect(member2.getByText(he.carPage.historyKindKilometrageCorrection)).toBeVisible();
      });
    } finally {
      await context.close();
    }

    await test.step("a plain member logs but cannot correct; the responsible person can", async () => {
      const { context: ctx, page: member1 } = await newSignedInPage(browser, SEEDED_USERS.member1);
      try {
        await expect(member1.getByRole("heading", { name: he.carPage.homeMyCarsTitle })).toBeVisible();
        await member1.goto(paths.car(SHARED_CAR_ID));
        await expect(member1.getByTestId("car-current-km")).toContainText("11,500");
        await expect(member1.getByTestId("car-km-correct")).toHaveCount(0);
        await member1.goto(paths.car(RESPONSIBLE_CAR_ID));
        await expect(member1.getByTestId("car-km-correct")).toBeVisible();
      } finally {
        await ctx.close();
      }
    });
  } finally {
    await service.from("car_odometer_readings").delete().eq("car_id", SHARED_CAR_ID);
    await service.rpc("admin_set_car_admin", { p_department_id: NEVO_DEPARTMENT_ID, p_profile_id: MEMBER2_ID, p_is_car_admin: false });
    await service.from("department_members").update({ is_car_admin: false }).eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", MEMBER2_ID);
  }
});
