import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { formatPlate } from "../src/lib/plate";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, openCarReports } from "./helpers";

/**
 * CR1 (REQ item 257, owner 2026-11-17/19/20): the car page on one page ordered by who needs what — the plate as
 * `xxx-xx-xxx`, the open issues at the top, the details edited in place (tire pressure, corporation with the names
 * already used suggested); the report dialog lists the open issues before a new report and shows the recommended
 * pressure above the tires.
 */
const service = serviceRoleClient();

test("car page: formatted plate, open issues on top, in-place edits, the report dialog knows both", { tag: ["@car-care", "@car-page"] }, async ({ browser }) => {
  test.slow();
  const { data: cars, error } = await service.from("cars")
    .select("id, name, license_plate, responsible_id, corporation, tire_pressure_front_psi, tire_pressure_rear_psi")
    .eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").order("id").limit(2);
  if (error) throw error;
  const [car, other] = cars!;
  const { data: reporter } = await service.from("profiles").select("id").eq("email", SEEDED_USERS.member2.email).single();
  const suggestion = `תאגיד בדיקה ${Date.now() % 10_000}`;
  const description = `נורית שמן ${Date.now() % 10_000}`;
  const prepared = await service.from("cars").update({ tire_pressure_front_psi: null, tire_pressure_rear_psi: null, corporation: null }).eq("id", car!.id);
  if (prepared.error) throw prepared.error;
  const suggested = await service.from("cars").update({ corporation: suggestion }).eq("id", other!.id);
  if (suggested.error) throw suggested.error;
  const { data: issue, error: issueError } = await service.from("car_issues")
    .insert({ car_id: car!.id, department_id: NEVO_DEPARTMENT_ID, reported_by: reporter!.id, description, is_unsafe: true }).select("id").single();
  if (issueError) throw issueError;

  try {
  const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
  try {
    const page = admin.page;
    await page.goto(paths.car(car!.id));
    await expect(page.getByTestId("car-plate")).toHaveText(formatPlate(car!.license_plate));
    // the plate in place, typed as 8 bare digits, reads xxx-xx-xxx (the service role may not change a plate:
    // cars_protect_owner_editable_fields — so it is put back the same way below)
    const plate = `9${String(Date.now()).slice(-7)}`;
    await page.getByTestId("car-reg-plate-edit").click();
    await page.getByTestId("car-reg-plate").getByRole("textbox").fill(plate);
    await page.getByTestId("car-reg-plate-save").click();
    await expect(page.getByTestId("car-plate")).toHaveText(`${plate.slice(0, 3)}-${plate.slice(3, 5)}-${plate.slice(5)}`);
    await expect(page.getByTestId("car-open-issues")).toContainText(description);
    await expect(page.getByTestId("car-open-issues")).toContainText(tv("carPage.openIssues", { count: "1" }));
    await expect(page.getByText(he.carPage.tierEveryone)).toBeVisible();
    await expect(page.getByText(he.carPage.tierManage)).toBeVisible();

    // tire pressure, in place
    await page.getByTestId("car-details-tires-edit").click();
    await page.getByTestId("car-tire-front").fill("32");
    await page.getByTestId("car-tire-rear").fill("30");
    await page.getByTestId("car-details-tires-save").click();
    await expect(page.getByTestId("car-details-tires")).toContainText(tv("adminCars.tirePressureValue", { front: "32", rear: "30" }));

    // corporation: the names already used are suggested
    await page.getByTestId("car-reg-corporation-edit").click();
    await expect(page.locator(`datalist option[value="${suggestion}"]`)).toHaveCount(1);
    await page.getByTestId("car-corporation-input").fill(suggestion);
    await page.getByTestId("car-corporation-input").press("Enter");
    await expect(page.getByTestId("car-reg-corporation")).toContainText(suggestion);
    await page.setViewportSize({ width: 390, height: 1600 });
    await page.screenshot({ path: test.info().outputPath("cr1-car-page.png"), fullPage: true });

    await page.getByTestId("car-reg-plate-edit").click();
    await page.getByTestId("car-reg-plate").getByRole("textbox").fill(car!.license_plate);
    await page.getByTestId("car-reg-plate-save").click();
    await expect(page.getByTestId("car-plate")).toHaveText(formatPlate(car!.license_plate));
    const { data: saved } = await service.from("cars").select("tire_pressure_front_psi, tire_pressure_rear_psi, corporation").eq("id", car!.id).single();
    expect(saved).toEqual({ tire_pressure_front_psi: 32, tire_pressure_rear_psi: 30, corporation: suggestion });
  } finally {
    await admin.context.close().catch(() => undefined);
  }

  // a plain member: not the car's responsible person (who may edit)
  const { data: m1 } = await service.from("profiles").select("id").eq("email", SEEDED_USERS.member1.email).single();
  const member = await newSignedInPage(browser, car!.responsible_id === m1!.id ? SEEDED_USERS.member2 : SEEDED_USERS.member1);
  try {
    const page = member.page;
    await page.goto(paths.car(car!.id));
    await expect(page.getByTestId("car-open-issues")).toContainText(description);
    await expect(page.getByTestId("car-details-tires-edit")).toHaveCount(0);
    await expect(page.getByText(he.carPage.tierManage)).toHaveCount(0);
    // REQ item 264: a plain member gets the collapsible reports, closed, without the car check.
    await expect(page.getByTestId("car-reports-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("car-mood-card")).toHaveCount(0);
    await openCarReports(page);
    await expect(page.getByTestId("car-report-problem")).toBeVisible();
    await expect(page.getByTestId("car-mood-card")).toBeVisible();
    await expect(page.getByTestId("car-checklist-card")).toHaveCount(0);
    await page.getByTestId("car-name-report-trigger").first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText(he.carCare.homeProblemTitle).click();
    await expect(dialog.getByTestId("car-known-issues")).toContainText(description);
    await dialog.getByRole("button", { name: he.common.back }).click();
    await dialog.getByText(he.carCare.homeTireFillTitle).click();
    await expect(dialog.getByTestId("tire-recommended")).toHaveText(tv("carCare.tireRecommended", { front: "32", rear: "30" }));
  } finally {
    await member.context.close().catch(() => undefined);
  }

  // CR2 (REQ item 257 b): whoever looks after the car taps the open issue: rewords it, schedules a טיפול, marks it handled.
  const { data: resp } = car!.responsible_id
    ? await service.from("profiles").select("email").eq("id", car!.responsible_id).single()
    : { data: null };
  const keeperUser = Object.values(SEEDED_USERS).find((u) => u.email === resp?.email) ?? SEEDED_USERS.admin;
  const keeper = await newSignedInPage(browser, keeperUser);
  try {
    const page = keeper.page;
    await page.goto(paths.car(car!.id));
    const banner = page.getByTestId("car-open-issues");
    await banner.getByRole("button", { name: new RegExp(description) }).click();
    const sheet = page.getByTestId("car-issue-sheet");
    await sheet.getByTestId("car-issue-edit").click();
    await page.getByTestId("car-issue-edit-input").fill(`${description} — נבדק`);
    await page.getByRole("dialog").getByRole("button", { name: he.carPage.saveField }).click();
    await expect(banner).toContainText(`${description} — נבדק`);

    await banner.getByRole("button", { name: new RegExp(description) }).click();
    await page.getByTestId("car-issue-maintenance").click();
    await expect(page.getByRole("dialog").getByRole("textbox").last()).toHaveValue(`${description} — נבדק`);
    await page.keyboard.press("Escape");

    await banner.getByRole("button", { name: new RegExp(description) }).click();
    await page.getByTestId("car-issue-resolve").click();
    await expect(page.getByText(he.carPage.issueResolvedToast)).toBeVisible();
    await expect(page.getByTestId("car-open-issues")).toHaveCount(0);
    const { data: done } = await service.from("car_issues").select("status").eq("id", issue!.id).single();
    expect(done!.status).toBe("resolved");
    // the history says when and by whom (owner 2026-11-20)
    await page.getByTestId("car-history").getByRole("button", { name: he.carPage.historyFilterIssue }).click();
    await expect(page.getByTestId("car-history-issue-resolved").first()).toContainText(keeperUser.fullName);
  } finally {
    await keeper.context.close().catch(() => undefined);
  }
  } finally {
    await service.from("car_issues").delete().eq("id", issue!.id);
    await service.from("cars").update({
      corporation: car!.corporation,
      tire_pressure_front_psi: car!.tire_pressure_front_psi, tire_pressure_rear_psi: car!.tire_pressure_rear_psi,
    }).eq("id", car!.id);
    await service.from("cars").update({ corporation: other!.corporation }).eq("id", other!.id);
  }
});
