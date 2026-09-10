import { expect, test } from '@playwright/test';
import { he } from '../src/i18n/he';
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn } from './helpers';

async function departmentFixture(options: { member?: { profileId: string; role: string } } = {}) {
  const service = serviceRoleClient();
  const suffix = Date.now();
  const { data: department, error } = await service.from('departments')
    .insert({ name: `Context department ${suffix}`, slug: `context-${suffix}` }).select('id,name').single();
  if (error || !department) throw error ?? new Error('Missing fixture');
  const { data: destination, error: destinationError } = await service.from('destinations')
    .insert({ department_id: department.id, name: `Context destination ${suffix}`, is_approved: true, distance_km: 4, travel_minutes: 8 })
    .select('id,name').single();
  if (destinationError || !destination) throw destinationError ?? new Error('Missing destination fixture');
  // The department switcher only lists departments the signed-in profile actually belongs to
  // (`useMyDepartments` reads `department_members` directly — admins get no implicit access;
  // see e2e/admin-department.spec.ts, "administrator can join a department through their member
  // editor"). Callers that need the switcher to already offer this department join here.
  if (options.member) {
    const { error: memberError } = await service.from('department_members')
      .insert({ department_id: department.id, profile_id: options.member.profileId, role: options.member.role });
    if (memberError) throw memberError;
  }
  return { service, department, destination };
}
async function cleanupDepartment(id: string) {
  const service = serviceRoleClient();
  const { error } = await service.from('departments').update({ is_active: false }).eq('id', id);
  if (error) throw error;
  for (const table of ['notifications', 'weeks', 'cars', 'destinations', 'departments']) {
    const cleanup = await service.from(table).delete().eq(table === 'departments' ? 'id' : 'department_id', id);
    if (cleanup.error) throw cleanup.error;
  }
}

test('department selector scopes catalogs and Maps estimates require explicit save', async ({ page }) => {
  // The signed-in admin must actually belong to the department to see it in the switcher —
  // admin power is global (`profiles.is_admin`), department membership is separate.
  const fixture = await departmentFixture({ member: { profileId: '00000000-0000-0000-0000-000000000101', role: 'member' } });
  try {
    await signIn(page, SEEDED_USERS.admin);
    await page.goto('/admin/destinations');
    await expect(page.getByRole('cell', { name: fixture.destination.name, exact: true })).toHaveCount(0);
    await page.getByLabel(he.departmentContext.label, { exact: true }).click();
    await page.getByRole('option', { name: fixture.department.name, exact: true }).click();
    await expect(page).toHaveURL(/\/my$/);
    await page.goto('/admin/destinations');
    await page.getByRole('cell', { name: fixture.destination.name, exact: true }).click();
    const editor = page.getByRole('dialog');
    const calculate = editor.getByRole('button', { name: he.adminDestinations.mapsCalculate, exact: true });
    await expect(calculate).toBeEnabled();
    await editor.getByLabel(he.adminDestinations.fieldName, { exact: true }).fill('Unsaved name');
    await expect(calculate).toBeDisabled();
    await editor.getByLabel(he.adminDestinations.fieldName, { exact: true }).fill(fixture.destination.name);
    await expect(calculate).toBeEnabled();
    await page.route('**/functions/v1/destination-route', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ department_id: fixture.department.id, destination_id: fixture.destination.id });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ distance_km: 12.3, travel_minutes: 25 }) });
    });
    await calculate.click();
    await expect(editor.getByLabel(he.adminDestinations.fieldDistanceKm)).toHaveValue('12.3');
    await expect(editor.getByLabel(he.adminDestinations.fieldTravelMinutes)).toHaveValue('25');
    const beforeSave = await fixture.service.from('destinations').select('distance_km,travel_minutes').eq('id', fixture.destination.id).single();
    expect(beforeSave.data).toEqual({ distance_km: 4, travel_minutes: 8 });
    await editor.getByLabel(he.adminDestinations.fieldTravelMinutes).fill('30');
    await editor.getByRole('button', { name: he.adminCommon.save, exact: true }).click();
    await expect(editor).not.toBeVisible();
    const afterSave = await fixture.service.from('destinations').select('distance_km,travel_minutes').eq('id', fixture.destination.id).single();
    expect(afterSave.data).toEqual({ distance_km: 12.3, travel_minutes: 30 });
    await page.reload();
    await expect(page.getByLabel(he.departmentContext.label, { exact: true })).toContainText(fixture.department.name);
    await expect(page.getByRole('cell', { name: fixture.destination.name, exact: true })).toBeVisible();
  } finally {
    await page.close();
    await cleanupDepartment(fixture.department.id);
  }
});

test('member can switch to another department for read-only viewing', async ({ page }) => {
  const fixture = await departmentFixture();
  try {
    await signIn(page, SEEDED_USERS.member1);
    await expect(page.getByText(he.departmentContext.noMembership)).toHaveCount(0);
    await page.getByLabel(he.departmentContext.label, { exact: true }).click();
    await page.getByRole('option', { name: fixture.department.name, exact: true }).click();
    await expect(page.getByText(he.departmentContext.viewOnly, { exact: true })).toBeVisible();
    await expect(page.getByText(he.departmentContext.noMembership)).toBeVisible();
    await page.goto('/requests/new');
    await expect(page.getByText(he.departmentContext.noMembership)).toBeVisible();
    await page.goto('/profile');
    await expect(page.getByRole('button', { name: he.action.registerTempCar, exact: true })).toBeDisabled();
    const home = await fixture.service.from('departments').select('name').eq('id', NEVO_DEPARTMENT_ID).single();
    if (home.error) throw home.error;
    await page.getByLabel(he.departmentContext.label, { exact: true }).click();
    await page.getByRole('option', { name: home.data!.name, exact: true }).click();
    await expect(page.getByText(he.departmentContext.viewOnly, { exact: true })).toHaveCount(0);
    await expect(page.getByText(he.departmentContext.noMembership)).toHaveCount(0);
    const membership = await fixture.service.from('department_members').insert({
      department_id: fixture.department.id, profile_id: '00000000-0000-0000-0000-000000000103', role: 'member',
    });
    if (membership.error) throw membership.error;
    await page.reload();
    await page.getByLabel(he.departmentContext.label, { exact: true }).click();
    await page.getByRole('option', { name: fixture.department.name, exact: true }).click();
    await expect(page.getByText(he.departmentContext.viewOnly, { exact: true })).toHaveCount(0);
    await page.goto('/profile');
    const carName = `Context temporary car ${Date.now()}`;
    await page.getByLabel(he.profileExtra.tempCarNickname, { exact: true }).fill(carName);
    await page.getByLabel(he.profileExtra.tempCarPlate, { exact: true }).fill(String(Date.now()).slice(-7));
    await page.getByRole('button', { name: he.action.registerTempCar, exact: true }).click();
    await expect(page.getByText(carName, { exact: true })).toBeVisible();
    const car = await fixture.service.from('cars').select('department_id').eq('name', carName).single();
    expect(car.data?.department_id).toBe(fixture.department.id);
  } finally {
    await page.close();
    await cleanupDepartment(fixture.department.id);
  }
});
