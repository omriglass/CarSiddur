import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * PC1 (REQ item 227): a private car with several owners. The seeded private car (`supabase/seed.sql`, owner member2):
 * member2 adds member1 on the car page; member1 is told, sees both owners and may manage them too; the last owner
 * cannot be removed (no ✕ on the only chip).
 */
const service = serviceRoleClient();
const PRIVATE_CAR = "00000000-0000-0000-0000-000000000043";
const MEMBER1 = "00000000-0000-0000-0000-000000000103";

test("an owner adds a co-owner; the co-owner is told and can manage the owners", { tag: ["@car-owners"] }, async ({ browser }) => {
  test.setTimeout(90_000);
  // start from the seed: member2 the only owner
  await service.from("car_owners").delete().eq("car_id", PRIVATE_CAR).eq("profile_id", MEMBER1);

  await test.step("member2 adds member1", async () => {
    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member2);
    await page.goto(paths.car(PRIVATE_CAR));
    const card = page.getByTestId("car-owners-card");
    await expect(card.getByTestId("car-owner")).toHaveCount(1);
    await expect(card.getByTestId("car-owner-remove")).toHaveCount(0);   // the last owner stays
    await card.getByTestId("car-owners-add").click();
    await page.getByTestId("car-owners-pick").click();
    await page.getByRole("option", { name: SEEDED_USERS.member1.fullName }).click();
    await page.getByRole("button", { name: he.carPage.ownersAddSubmit }).click();
    await expect(page.getByText(he.carPage.ownerAdded)).toBeVisible();
    await expect(card.getByTestId("car-owner")).toHaveCount(2);
    await context.close();
  });

  await test.step("member1 is told and manages the owners too", async () => {
    const { data: notices } = await service.from("notifications").select("title_he")
      .eq("recipient_id", MEMBER1).eq("event", "private_car_changed");
    expect(notices?.length).toBe(1);

    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member1);
    await page.goto(paths.car(PRIVATE_CAR));
    const card = page.getByTestId("car-owners-card");
    await expect(card.getByTestId("car-owner")).toHaveCount(2);
    await expect(card.getByText(tv("carPage.ownersMe", { name: SEEDED_USERS.member1.fullName }))).toBeVisible();
    await expect(card.getByTestId("car-owner-remove")).toHaveCount(2);
    await expect(card.getByTestId("car-owners-add")).toBeVisible();
    await context.close();
  });

  await service.from("car_owners").delete().eq("car_id", PRIVATE_CAR).eq("profile_id", MEMBER1);
  await service.from("notifications").delete().eq("recipient_id", MEMBER1).eq("event", "private_car_changed");
});
