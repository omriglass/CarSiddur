import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

/**
 * "איך עושים…" guides per car (REQ item 259, UX_FLOWS §5.11 / §5.16): the admin defines a required topic on
 * `/cars/guides/:dept`; the car page then says "לא הוזן מדריך: …" to whoever manages the car; writing the guide in
 * place clears it; a member opens it from the car menu and steps through it one step at a time.
 */
const service = serviceRoleClient();
const TOPIC = "e2e איפוס לחץ אוויר";

test.afterAll(async () => {
  await service.from("car_guides").delete().eq("title", TOPIC);
  await service.from("car_guide_topics").delete().eq("title", TOPIC);
});

test("a required guide topic is flagged on the car, written in place and read step by step", { tag: ["@car-guides"] }, async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { data: car, error } = await service
    .from("cars").select("id, name").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").neq("status", "retired")
    .order("name").limit(1).single();
  if (error) throw error;

  await signIn(page, SEEDED_USERS.admin);

  await test.step("the admin defines a required topic", async () => {
    await page.goto(paths.carGuideTopics(NEVO_DEPARTMENT_ID));
    await page.getByTestId("guide-topic-add").click();
    await page.getByTestId("guide-topic-title").fill(TOPIC);
    await page.getByRole("button", { name: he.carGuides.topics.save }).click();
    await expect(page.getByTestId("guide-topic").filter({ hasText: TOPIC })).toBeVisible();
  });

  await test.step("the car page flags it and the guide is written in place", async () => {
    await page.goto(paths.car(car!.id));
    await expect(page.getByTestId("car-guides-missing")).toContainText(TOPIC);
    await page.getByTestId("car-guide-missing-row").filter({ hasText: TOPIC }).getByTestId("car-guide-write").click();
    await page.getByTestId("guide-step-input").first().fill("לוחצים על כפתור TPMS");
    await page.getByTestId("guide-add-step").click();
    await page.getByTestId("guide-step-input").nth(1).fill("מחזיקים 3 שניות עד שהנורה מהבהבת");
    await page.getByRole("button", { name: he.carGuides.editor.save }).click();
    await expect(page.getByTestId("car-guide-row").filter({ hasText: TOPIC })).toBeVisible();
    await expect(page.getByTestId("car-guides-missing")).toHaveCount(0);
  });

  await test.step("a member opens it from the car menu, one step at a time", async () => {
    const { context, page: member } = await newSignedInPage(browser, SEEDED_USERS.member2);
    await member.goto(paths.car(car!.id));
    await member.getByTestId("car-name-report-trigger").click();
    await member.getByTestId("car-menu-guides").click();
    await member.getByTestId("car-guide-open").filter({ hasText: TOPIC }).click();
    await expect(member.getByTestId("guide-step-of")).toHaveText(tv("carGuides.stepOf", { n: "1", total: "2" }));
    await member.getByTestId("guide-step").click();
    await expect(member.getByTestId("guide-step")).toHaveText("מחזיקים 3 שניות עד שהנורה מהבהבת");
    await member.getByTestId("guide-done").click();
    await expect(member.getByTestId("car-guides-list")).toBeVisible();
    // A reader does not get the editing controls.
    await member.keyboard.press("Escape");
    await expect(member.getByTestId("car-guide-row").filter({ hasText: TOPIC })).toBeVisible();
    await expect(member.getByTestId("car-guide-edit")).toHaveCount(0);
    await context.close();
  });
});
