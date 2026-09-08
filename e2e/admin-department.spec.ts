import { expect, test } from "@playwright/test";
import { he } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

test("administrator can join a department through their member editor", async ({ page }) => {
  const service = serviceRoleClient();
  const suffix = Date.now();
  const { data: department, error } = await service.from("departments")
    .insert({ name: `Admin membership test ${suffix}`, slug: `admin-membership-${suffix}` }).select("id, name").single();
  if (error || !department) throw error ?? new Error("Missing department fixture");
  let cleanupError: unknown = null;
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
    await row.getByRole("button", { name: SEEDED_USERS.admin.fullName, exact: true }).click();
    const membership = dialog.locator("div.flex").filter({ has: page.getByText(department.name, { exact: true }) });
    await membership.getByRole("button", { name: he.adminMembers.removeDepartment, exact: true }).click();
    await expect(membership.getByRole("button", { name: he.adminMembers.undoRemoval, exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: he.adminCommon.save, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row).not.toContainText(department.name);
    await expect(row.getByRole("button", { name: he.adminMembers.revokeAdmin, exact: true })).toBeVisible();
  } finally {
    // Membership refresh creates weeks and opening notifications automatically.
    // Stop browser/cron catch-up before removing this test-only department.
    await page.close();
    const deactivate = await service.from("departments").update({ is_active: false }).eq("id", department.id);
    cleanupError = deactivate.error;
    for (const table of ["notifications", "weeks", "departments"] as const) {
      if (cleanupError) break;
      const cleanup = await service.from(table).delete().eq(table === "departments" ? "id" : "department_id", department.id);
      cleanupError = cleanup.error;
    }
  }
  if (cleanupError) throw cleanupError;
});

test('administrator sets and clears a display name while keeping the Google name', async ({ page }) => {
  const service = serviceRoleClient();
  const { data: original, error } = await service.from('profiles').select('id,google_name,display_name')
    .eq('email', SEEDED_USERS.member2.email).single();
  if (error || !original) throw error ?? new Error('Missing member fixture');
  const nickname = `Nickname ${Date.now()}`;
  let cleanupError: unknown = null;
  try {
    await signIn(page, SEEDED_USERS.admin);
    await page.goto('/admin/members');
    const row = page.getByRole('row').filter({ hasText: SEEDED_USERS.member2.email });
    await row.getByRole('button').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(he.adminMembers.googleName, { exact: true })).toHaveValue(original.google_name);
    await expect(dialog.getByLabel(he.adminMembers.googleName, { exact: true })).toHaveAttribute('readonly', '');
    await dialog.getByLabel(he.adminMembers.displayName, { exact: true }).fill(nickname);
    await dialog.getByRole('button', { name: he.adminCommon.save, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row.getByRole('button', { name: nickname, exact: true })).toBeVisible();
    await page.reload();
    await row.getByRole('button', { name: nickname, exact: true }).click();
    await dialog.getByLabel(he.adminMembers.displayName, { exact: true }).fill('');
    await dialog.getByRole('button', { name: he.adminCommon.save, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(row.getByRole('button', { name: original.google_name, exact: true })).toBeVisible();
  } finally {
    await page.close();
    const cleanup = await service.from('profiles').update({ display_name: original.display_name }).eq('id', original.id);
    cleanupError = cleanup.error;
  }
  if (cleanupError) throw cleanupError;
});
