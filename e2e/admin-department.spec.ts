import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

test("administrator can join a department through their member editor", async ({ page }) => {
  const service = serviceRoleClient();
  const { data: department, error } = await service.from("departments")
    .insert({ name: "Admin membership test", slug: `admin-membership-${Date.now()}` }).select("id, name").single();
  if (error || !department) throw error ?? new Error("Missing department fixture");
  try {
    await signIn(page, SEEDED_USERS.admin);
    await page.goto("/admin/members");
    const row = page.getByRole("row").filter({ hasText: SEEDED_USERS.admin.email });
    await row.getByRole("button", { name: SEEDED_USERS.admin.fullName, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(he.adminMembers.addDepartment, { exact: true }).click();
    await page.getByRole("option", { name: department.name, exact: true }).click();
    await dialog.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).toContainText(department.name);
    await expect(row.getByRole("button", { name: he.adminMembers.revokeAdmin, exact: true })).toBeVisible();
  } finally {
    const { error: cleanupError } = await service.from("departments").delete().eq("id", department.id);
    if (cleanupError) throw cleanupError;
  }
});
