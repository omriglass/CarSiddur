import { expect, test, type BrowserContext } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import {
  dayOfWeek, dragRequestToCar, ensureUnpublishedWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName,
} from "./request-form";

// REQ §13.111 (a), UX_FLOWS §4.2: "needs a large trunk" is a requirement the Sadran may waive when placing by hand.
// Dropping a large-luggage request on a car without a large trunk asks "צריך תא מטען גדול … לשבץ בכל זאת?":
//  - confirm: the request is placed, the luggage need is marked waived (who/when kept) and the block says "ויתור על תא מטען גדול";
//  - decline: nothing is placed, the request stays unmet and the requirement stays.
const WEEK = FIXTURE_WEEKS.largeTrunk;
const DAY = dayOfWeek(WEEK, 1);
const SMALL_CAR = "יונדאי 1";

test.describe("large trunk waiver on the board", { tag: ["@board"] }, () => {
  const service = serviceRoleClient();
  const contexts: BrowserContext[] = [];
  let requestId = "";
  let carId = "";

  test.beforeEach(async () => {
    await ensureUnpublishedWeek(service, WEEK, "solving");
    carId = await sharedCarIdByName(service, SMALL_CAR);
    // ±1 hour of flexibility so a hand drop near 08:00 is a plain placement, not a "beyond flexibility" proposal.
    requestId = await insertRequest(service, DAY, {
      week: WEEK, requester: PROFILE_IDS.member1, depart: "08:00", return: "10:00", destinationId: PLACES.haifa.id,
      hasLuggage: true, flex: "01:00:00",
    });
  });

  test.afterEach(async () => {
    for (const context of contexts.splice(0)) await context.close().catch(() => undefined);
    await removeWeek(service, WEEK);
  });

  test("confirming places the request on the small car and marks the waiver", async ({ browser }) => {
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, WEEK));
    await expect(page.locator(`[data-request-id="${requestId}"]:visible`).first()).toBeVisible();

    await dragRequestToCar(page, requestId, carId, 8 * 60);

    const dialog = page.getByRole("dialog").filter({ hasText: he.smallTrunk.confirmTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(SMALL_CAR);
    await dialog.getByRole("button", { name: he.smallTrunk.confirmAction, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const block = page.locator(`[data-car-col-id="${carId}"] button[data-ride-id]`).first();
    await expect(block).toBeVisible({ timeout: 15_000 });
    await expect(block.getByTestId("luggage-marker")).toHaveAttribute("data-waived", "true");
    await expect(block.getByTestId("luggage-marker")).toHaveText(he.smallTrunk.waivedLabel);

    const { data: request } = await service.from("requests").select("luggage_waived_at, luggage_waived_by, has_luggage").eq("id", requestId).single();
    expect(request!.has_luggage).toBe(true);
    expect(request!.luggage_waived_at).not.toBeNull();
    expect(request!.luggage_waived_by).toBe(PROFILE_IDS.sadran);
    const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId);
    expect(links).toHaveLength(1);
    const { data: ride } = await service.from("rides").select("car_id").eq("id", links![0]!.ride_id as string).single();
    expect(ride!.car_id).toBe(carId);
  });

  test("declining leaves the request unmet and the requirement in place", async ({ browser }) => {
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, WEEK));
    await expect(page.locator(`[data-request-id="${requestId}"]:visible`).first()).toBeVisible();

    await dragRequestToCar(page, requestId, carId, 8 * 60);

    const dialog = page.getByRole("dialog").filter({ hasText: he.smallTrunk.confirmTitle });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(SMALL_CAR);
    await dialog.getByRole("button", { name: he.common.cancel, exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect(page.locator(`[data-request-id="${requestId}"]:visible`).first()).toBeVisible();
    await expect(page.locator(`[data-car-col-id="${carId}"] button[data-ride-id]`)).toHaveCount(0);
    const { data: request } = await service.from("requests").select("luggage_waived_at, status").eq("id", requestId).single();
    expect(request!.luggage_waived_at).toBeNull();
    expect(request!.status).toBe("submitted");
    const { data: links } = await service.from("ride_requests").select("ride_id").eq("request_id", requestId);
    expect(links).toEqual([]);
  });
});
