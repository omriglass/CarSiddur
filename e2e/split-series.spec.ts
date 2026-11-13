import { expect, test } from "@playwright/test";

import { he, t, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";

/**
 * SP1 (REQ item 228): "פיצול" on a multi-day request in "הנסיעות שלי" — split in two at a chosen day. The first day
 * becomes an ordinary request, the other two a two-day series of their own; every day keeps its own times.
 */
const DESTINATION = "E2E split destination";

test.use({ viewport: { width: 390, height: 844 } });

test("a member splits a 3-day request 1 + 2 from /my", { tag: ["@request-form"] }, async ({ page }) => {
  const service = serviceRoleClient();
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);

  await signIn(page, SEEDED_USERS.member1);
  await page.goto("/requests/new");
  await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
  await page.getByPlaceholder("לאן?").fill(DESTINATION);
  await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();
  await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();
  await page.getByRole("button", { name: t("request.returnAnotherDay"), exact: true }).click();
  await page.getByRole("radiogroup", { name: t("request.returnDay") }).getByRole("radio").nth(1).click();
  await expect(page.getByText(tv("request.multiDayBadge", { count: "3" }))).toBeVisible();
  await submitRequestForm(page);
  await expect(page).toHaveURL(/\/my$/);

  const { data: before } = await service.from("requests").select("id, depart_at, return_at")
    .eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION).order("depart_at");
  expect(before?.length).toBe(3);

  const card = page.locator("[data-request-id]").filter({ hasText: DESTINATION });
  await card.getByTestId("request-row-split").click();
  const form = page.getByTestId("split-series-form");
  await expect(form).toBeVisible();
  await form.getByTestId("split-at").first().click();   // 1 + 2
  await expect(form.getByTestId("split-parts").locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: he.request.splitSubmit, exact: true }).click();
  await expect(page.getByText(he.request.splitDone)).toBeVisible();

  const { data: after } = await service.from("requests").select("id, series_id, series_index, series_count, depart_at, return_at, status")
    .eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION).order("depart_at");
  expect(after?.length).toBe(3);
  const [day1, day2, day3] = after!;
  expect(day1!.series_id).toBeNull();
  expect(day2!.series_id).toBeTruthy();
  expect(day3!.series_id).toBe(day2!.series_id);
  expect([day2!.series_index, day2!.series_count, day3!.series_index, day3!.series_count]).toEqual([1, 2, 2, 2]);
  // nothing else changed: the same days, the same times, still active
  expect(after!.map((r) => [r.id, r.depart_at, r.return_at])).toEqual(before!.map((r) => [r.id, r.depart_at, r.return_at]));
  expect(after!.every((r) => r.status !== "withdrawn" && r.status !== "cancelled")).toBe(true);

  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("destination_text", DESTINATION);
});
