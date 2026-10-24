import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * REQ item 150 (b): the car's manager asks the next user for tyres + kilometrage + a free-text task; the driver of
 * a ride whose window (start − 15 min … end + 15 min) contains now sees them on /my, does the kilometrage (its task
 * completes) and ticks "ביצעתי"; outside the window nothing shows. The window is the server's clock, so the ride is
 * created around the real now (page.clock is not needed).
 */

const service = serviceRoleClient();
const CAR_ID = "00000000-0000-0000-0000-000000000041"; // shared, no responsible person (seed.sql)
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const SADRAN_ID = "00000000-0000-0000-0000-000000000102";
const HOME_ID = "00000000-0000-0000-0000-000000000010";
const QUARTER_MS = 15 * 60_000;

function quarterAfter(offsetMinutes: number): string {
  return new Date(Math.floor((Date.now() + offsetMinutes * 60_000) / QUARTER_MS) * QUARTER_MS).toISOString();
}

async function createRide(startOffsetMinutes: number, endOffsetMinutes: number): Promise<string> {
  const { data, error } = await service
    .from("rides")
    .insert({
      department_id: NEVO_DEPARTMENT_ID,
      week_start: await getWeekStart("live"),
      car_id: CAR_ID,
      starts_at: quarterAfter(startOffsetMinutes),
      ends_at: quarterAfter(endOffsetMinutes),
      origin_id: HOME_ID,
      destination_id: HOME_ID,
      driver_id: MEMBER1_ID,
      status: "confirmed",
      is_pinned: true,
      pin_reason: "E2E",
      notes: "e2e",
      created_by: SADRAN_ID,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

test("manager asks the next user; the driver sees it only in the window and completes it", { tag: ["@car-tasks"] }, async ({ browser }) => {
  test.setTimeout(150_000);
  let rideId: string | null = null;
  await service.from("rides").delete().eq("pin_reason", "E2E"); // a crashed earlier run
  try {
    rideId = await createRide(-30, 90);

    const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
    try {
      await test.step("the manager requests tyres, kilometrage and a free-text task", async () => {
        await admin.page.goto(paths.car(CAR_ID));
        await admin.page.getByTestId("car-tasks-request").click();
        const dialog = admin.page.getByRole("dialog");
        await dialog.getByTestId("car-task-kind-tire_fill").click();
        await dialog.getByTestId("car-task-kind-kilometrage").click();
        await dialog.getByTestId("car-task-kind-other").click();
        await expect(dialog.getByRole("button", { name: he.carTasks.requestSubmit })).toBeDisabled();
        await dialog.getByTestId("car-task-note").fill("להחזיר את המפתח");
        await dialog.getByRole("button", { name: he.carTasks.requestSubmit }).click();
        await expect(admin.page.getByTestId("car-task-row")).toHaveCount(3);
      });

      const member = await newSignedInPage(browser, SEEDED_USERS.member1);
      try {
        await test.step("the driver sees all three on /my and does the kilometrage", async () => {
          await expect(member.page.getByTestId("my-car-task")).toHaveCount(3);
          await member.page.getByTestId("car-task-open-kilometrage").click();
          const dialog = member.page.getByRole("dialog");
          await dialog.getByTestId("car-km-input").fill("20500");
          await dialog.getByRole("button", { name: he.carCare.kmSave }).click();
          await expect(member.page.getByTestId("my-car-task")).toHaveCount(2);
        });

        await test.step('"ביצעתי" completes the free-text task', async () => {
          await member.page.getByTestId("car-task-done").click();
          await expect(member.page.getByTestId("my-car-task")).toHaveCount(1);
        });

        await test.step("outside the window the card is gone", async () => {
          await service.from("rides").update({ starts_at: quarterAfter(240), ends_at: quarterAfter(360) }).eq("id", rideId as string);
          await member.page.reload();
          await member.page.waitForLoadState("networkidle");
          await expect(member.page.getByTestId("my-car-tasks")).toHaveCount(0);
        });
      } finally {
        await member.context.close();
      }

      await test.step("the manager withdraws the open task; history lists all three", async () => {
        await admin.page.reload();
        await expect(admin.page.getByTestId("car-task-row")).toHaveCount(1);
        await admin.page.getByTestId("car-task-withdraw").click();
        await expect(admin.page.getByTestId("car-task-row")).toHaveCount(0);
        await admin.page.getByRole("tab", { name: he.carPage.tabHistory }).click();
        await expect(admin.page.getByTestId("car-history-task")).toHaveCount(3);
      });
    } finally {
      await admin.context.close();
    }
  } finally {
    await service.from("car_tasks").delete().eq("car_id", CAR_ID);
    await service.from("car_odometer_readings").delete().eq("car_id", CAR_ID);
    if (rideId) await service.from("rides").delete().eq("id", rideId);
  }
});
