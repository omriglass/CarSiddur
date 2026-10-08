import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";
import { PLACES } from "./request-form";

// REQ §13.112 (a)/(f): plan B drops a member at a "drop point"; the owner marks the places in /admin/destinations — a
// "נקודת הקפצה" switch in the editor and a column (badge) in the list. Admins and the department's Sadran both manage the
// destination catalog (admin.spec.ts, "Sadran operational administration"), so both are checked.
for (const role of ["admin", "sadran"] as const) {
  test.describe(`drop points in the destinations admin (${role})`, { tag: ["@admin", "@request-form"] }, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await signIn(page, SEEDED_USERS[role]);
    });

    test("the list has a drop-point column, and the switch marks and unmarks a place", async ({ page }) => {
      const service = serviceRoleClient();
      const name = `E2E נקודת הקפצה ${role} ${Date.now()}`;
      try {
        await page.goto("/admin/destinations");
        await expect(page.getByRole("columnheader", { name: he.adminDestinations.dropPointBadge, exact: true })).toBeVisible();

        await test.step("the seeded drop points carry the badge, other places do not", async () => {
          await expect(page.getByRole("row").filter({ hasText: PLACES.binyamina.name }).getByTestId("destination-drop-point-badge")).toBeVisible();
          await expect(page.getByRole("row").filter({ hasText: PLACES.haifa.name }).getByTestId("destination-drop-point-badge")).toHaveCount(0);
        });

        await test.step("a new place saved with the switch on shows the badge", async () => {
          await page.getByRole("button", { name: he.adminDestinations.new }).click();
          await page.getByLabel(he.adminDestinations.fieldName).fill(name);
          const toggle = page.getByTestId("destination-drop-point");
          await expect(toggle).toHaveAttribute("aria-checked", "false");
          await toggle.click();
          await expect(toggle).toHaveAttribute("aria-checked", "true");
          await page.getByRole("button", { name: he.adminCommon.save, exact: true }).click();

          const row = page.getByRole("row").filter({ hasText: name });
          await expect(row.getByTestId("destination-drop-point-badge")).toBeVisible();
          const { data } = await service.from("destinations").select("is_drop_point").eq("department_id", NEVO_DEPARTMENT_ID).eq("name", name).single();
          expect(data!.is_drop_point).toBe(true);
        });

        await test.step("switching it off removes the badge", async () => {
          await page.getByRole("row").filter({ hasText: name }).click();
          const toggle = page.getByTestId("destination-drop-point");
          await expect(toggle).toHaveAttribute("aria-checked", "true");
          await toggle.click();
          await page.getByRole("button", { name: he.adminCommon.save, exact: true }).click();

          await expect.poll(async () => {
            const { data } = await service.from("destinations").select("is_drop_point").eq("department_id", NEVO_DEPARTMENT_ID).eq("name", name).single();
            return data!.is_drop_point;
          }).toBe(false);
          const row = page.getByRole("row").filter({ hasText: name });
          await expect(row).toBeVisible();
          await expect(row.getByTestId("destination-drop-point-badge")).toHaveCount(0);
        });
      } finally {
        await service.from("destinations").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("name", name);
      }
    });
  });
}
