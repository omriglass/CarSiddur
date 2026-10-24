import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * REQ item 150 (d): a car admin defines the department's checklist; a new responsible person is asked to complete
 * it (card on /my, banner on the car page); the result is green or not green as of its date, a not-green one lists
 * what failed; the car admin of a private car may only change its status.
 */

const service = serviceRoleClient();
const CAR_ID = "00000000-0000-0000-0000-000000000041"; // shared, no responsible person (seed.sql)
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const MEMBER2_ID = "00000000-0000-0000-0000-000000000104";

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function cleanup() {
  await service.from("car_checklist_prompts").delete().eq("department_id", NEVO_DEPARTMENT_ID);
  await service.from("car_checklists").delete().eq("department_id", NEVO_DEPARTMENT_ID);
  await service.from("car_checklist_items").delete().eq("department_id", NEVO_DEPARTMENT_ID);
  await service.from("cars").update({ responsible_id: null }).eq("id", CAR_ID);
  await service.from("department_members").update({ is_car_admin: false }).eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", MEMBER2_ID);
}

test("car admin defines the checklist, the new responsible person completes it: green / not green as of its date", { tag: ["@car-checklist"] }, async ({ browser }) => {
  test.setTimeout(180_000);
  await cleanup();
  await service.from("department_members").update({ is_car_admin: true }).eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", MEMBER2_ID);
  try {
    const { context: adminCtx, page: carAdmin } = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await test.step("the car admin defines three items (not a Sadran, not an admin)", async () => {
        await carAdmin.goto(paths.car(CAR_ID));
        await carAdmin.getByTestId("checklist-edit-link").click();
        await expect(carAdmin.getByTestId("checklist-editor")).toBeVisible();
        let added = 0;
        for (const [label, kind] of [["Oil level ok", "yes_no"], ["Mileage at last service", "number"], ["Insurance until", "date"]] as const) {
          await carAdmin.getByTestId("checklist-add").click();
          const dialog = carAdmin.getByRole("dialog");
          await dialog.getByTestId("checklist-item-label").fill(label);
          if (kind !== "yes_no") {
            await dialog.getByTestId("checklist-item-kind").click();
            await carAdmin.getByRole("option", { name: he.carChecklist.kindLabel[kind] }).click();
          }
          if (kind === "date") await dialog.getByTestId("checklist-item-remind").fill("14");
          await dialog.getByRole("button", { name: he.carChecklist.editor.save }).click();
          added += 1;
          await expect(carAdmin.getByTestId("checklist-item")).toHaveCount(added);
        }
        await expect(carAdmin.getByTestId("checklist-item")).toHaveCount(3);
      });
    } finally {
      await adminCtx.close();
    }

    // The department admin makes member1 the responsible person of the car.
    await service.from("cars").update({ responsible_id: MEMBER1_ID }).eq("id", CAR_ID);

    const { context, page: member1 } = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await test.step("the new responsible person sees the prompt on /my and on the car page", async () => {
        await expect(member1.getByTestId("home-checklist-prompt")).toBeVisible();
        await member1.goto(paths.car(CAR_ID));
        await expect(member1.getByTestId("checklist-prompt")).toBeVisible();
        await expect(member1.getByTestId("checklist-status")).toHaveText(he.carChecklist.none);
      });

      async function fillAndSave(oilYes: boolean, insuranceDate: string) {
        await member1.getByTestId("checklist-open").click();
        const dialog = member1.getByRole("dialog");
        const items = dialog.getByTestId("checklist-form-item");
        await items.nth(0).getByTestId(oilYes ? "checklist-yes" : "checklist-no").click();
        await items.nth(1).getByTestId("checklist-number").fill("45000");
        await items.nth(2).getByTestId("checklist-date").fill(insuranceDate);
        await dialog.getByRole("button", { name: he.carChecklist.form.submit }).click();
        await expect(member1.getByText(he.carChecklist.submitted).first()).toBeVisible();
      }

      await test.step("not green: a 'no' and an expired date are listed", async () => {
        await fillAndSave(false, isoDay(-30));
        await expect(member1.getByTestId("checklist-status")).toContainText(he.carChecklist.notGreen.replace(/\{\{.*$/, "").trim());
        const failures = member1.getByTestId("checklist-failures");
        await expect(failures).toContainText("Oil level ok");
        await expect(failures).toContainText("Insurance until");
        await expect(member1.getByTestId("checklist-prompt")).toHaveCount(0);
      });

      await test.step("green: everything yes and a future date; the status says green as of today", async () => {
        await fillAndSave(true, isoDay(30));
        await expect(member1.getByTestId("checklist-status")).toContainText(he.carChecklist.green.replace(/\{\{.*$/, "").trim());
        await expect(member1.getByTestId("checklist-failures")).toHaveCount(0);
      });

      await test.step("renaming an item does not rewrite the last result", async () => {
        const { data } = await service.from("car_checklist_items").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("label", "Oil level ok").single();
        await service.from("car_checklist_items").update({ label: "Oil renamed" }).eq("id", data?.id ?? "");
        const { data: answers } = await service.from("car_checklist_answers").select("label").eq("department_id", NEVO_DEPARTMENT_ID).eq("position", 0);
        expect((answers ?? []).every((row) => row.label === "Oil level ok")).toBe(true);
      });
    } finally {
      await context.close();
    }
  } finally {
    await cleanup();
  }
});

const PRIVATE_CAR_ID = "00000000-0000-0000-0000-000000000043"; // temporary, owner = member2 (seed.sql)

test("a car admin of a private car gets a status select only", { tag: ["@car-checklist"] }, async ({ browser }) => {
  await service.from("department_members").update({ is_car_admin: true }).eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", MEMBER1_ID);
  const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member1);
  try {
    await page.goto(paths.car(PRIVATE_CAR_ID));
    await expect(page.getByTestId("car-status-select")).toBeVisible();
    await expect(page.getByTestId("car-private-card").getByRole("switch")).toHaveCount(0);
    await page.getByTestId("car-status-select").click();
    await page.getByRole("option", { name: he.car.status.maintenance }).click();
    await expect.poll(async () => (await service.from("cars").select("status").eq("id", PRIVATE_CAR_ID).single()).data?.status).toBe("maintenance");
  } finally {
    await context.close();
    await service.from("cars").update({ status: "active" }).eq("id", PRIVATE_CAR_ID);
    await service.from("department_members").update({ is_car_admin: false }).eq("department_id", NEVO_DEPARTMENT_ID).eq("profile_id", MEMBER1_ID);
  }
});
