import { expect, test, type BrowserContext } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, t, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";
import {
  dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, reserveCar, sharedCarIdByName, winterAt,
} from "./request-form";

// REQ §13.112 (a)/(e)/(f), UX_FLOWS §3.4a / §4.2 / §3.6: the whole plan-B cycle.
//  fixture: a member's round trip to Jerusalem (08:00-18:00) with a plan B (drop at Binyamina by 09:00, pickup from Pardes
//  Hanna at 17:00) on a Monday where every shared car is held all day or mid-day, so the main trip cannot be placed but the
//  two הקפצה legs fit around the mid-day hold of the first car (reservations made through the service role).
//  1. Sadran: the unmet card shows "תוכנית ב׳: …" and "תוכנית ב׳ אפשרית · להציע"; the composer lists the cars and times;
//     the proposal is sent; publishing the day is refused while it is pending (the publish screen lists it).
//  2. Member: /p/<token> states the car, the times and what is replaced; accepting serves the request by plan B (/my
//     "שובצת בתוכנית ב׳"); removing it removes the linked pickup request too.
// Serial: the second test continues with the proposal the first one sent.
const WEEK = FIXTURE_WEEKS.planBCycle;
const DAY = dayOfWeek(WEEK, 1);
const CAR_NAMES = { plan: "יונדאי 1", busyA: "ואן 7 מקומות", busyB: "יונדאי 2" } as const;

test.describe.serial("plan B cycle: unmet card, proposal, publish block, member answer, removal", { tag: ["@board", "@proposals", "@publication", "@request-form"] }, () => {
  const service = serviceRoleClient();
  let requestId = "";
  let token = "";
  const contexts: BrowserContext[] = [];

  test.beforeAll(async () => {
    await removeWeek(service, WEEK);
    const { error: weekError } = await service.from("weeks").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "open",
      open_at: "2000-01-01T00:00:00Z", close_at: "2090-01-01T00:00:00Z", publish_at: "2090-01-02T00:00:00Z",
    });
    if (weekError) throw weekError;

    const planCar = await sharedCarIdByName(service, CAR_NAMES.plan);
    await reserveCar(service, WEEK, planCar, DAY, "10:30", "15:00");
    await reserveCar(service, WEEK, await sharedCarIdByName(service, CAR_NAMES.busyA), DAY, "06:30", "21:00");
    await reserveCar(service, WEEK, await sharedCarIdByName(service, CAR_NAMES.busyB), DAY, "06:30", "21:00");

    requestId = await insertRequest(service, DAY, {
      week: WEEK, requester: PROFILE_IDS.member1, depart: "08:00", return: "18:00", destinationId: PLACES.jerusalem.id,
      extra: { fallback: "alternative" },
    });
    const { error: altError } = await service.from("request_alternatives").insert({
      request_id: requestId, department_id: NEVO_DEPARTMENT_ID, week_start: WEEK,
      drop_place_id: PLACES.binyamina.id, arrive_by: winterAt(DAY, "09:00"),
      pickup: true, pickup_at: winterAt(DAY, "17:00"), pickup_place_id: PLACES.pardesHanna.id,
    });
    if (altError) throw altError;
  });

  test.afterAll(async () => {
    for (const context of contexts) await context.close().catch(() => undefined);
    await removeWeek(service, WEEK);
  });

  test("Sadran sees the plan B on the unmet card, proposes it, and publishing waits for the answer", async ({ browser }) => {
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });

    await test.step("the unmet card shows the member's plan B and that it is possible", async () => {
      await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, WEEK));
      const card = page.locator(`[data-request-id="${requestId}"]:visible`).first();
      await expect(card).toBeVisible();
      const plan = tv("sadranProposal.alternativePlan", {
        dropPlace: PLACES.binyamina.name, dropTime: "09:00",
        pickupLine: tv("sadranProposal.alternativePickupFrom", { pickupPlace: PLACES.pardesHanna.name, pickupTime: "17:00" }),
      });
      await expect(card.getByTestId("unmet-fallback")).toContainText(tv("sadranPlanB.line", { plan }));
      // The board's own solver preview decides "possible"; give it time to run.
      await expect(card.getByTestId("unmet-plan-b-possible")).toHaveText(he.sadranPlanB.possible, { timeout: 20_000 });
      await expect(card.getByTestId("unmet-plan-b-propose")).toHaveText(he.sadranPlanB.propose);
    });

    await test.step("the composer lists the cars and times; send the proposal", async () => {
      await page.locator(`[data-request-id="${requestId}"]:visible`).first().getByTestId("unmet-plan-b-propose").click();
      await page.getByTestId("draft-choice-compose").click();
      await expect(page).toHaveURL(/\/proposals\/new$/);

      const cars = page.getByTestId("composer-alt-cars");
      await expect(cars).toBeVisible();
      await expect(cars.getByTestId("composer-alt-out-line")).toContainText(PLACES.binyamina.name);
      await expect(cars.getByTestId("composer-alt-out-line")).toContainText("09:00");
      await expect(cars.getByTestId("composer-alt-out-car")).toContainText(CAR_NAMES.plan);
      await expect(cars.getByTestId("composer-alt-pickup-line")).toContainText("17:00");
      await expect(cars.getByTestId("composer-alt-pickup-line")).toContainText(PLACES.pardesHanna.name);
      await expect(cars.getByTestId("composer-alt-pickup-car")).toContainText(CAR_NAMES.plan);
      await expect(cars.getByTestId("composer-alt-other-car")).toHaveCount(0);

      const sent = page.waitForResponse((response) => response.url().endsWith("/rest/v1/rpc/send_proposal") && response.request().method() === "POST");
      await page.getByTestId("composer-send").click();
      const result = (await (await sent).json()) as { party_tokens: Record<string, string> };
      token = result.party_tokens[PROFILE_IDS.member1] ?? "";
      expect(token).not.toBe("");

      await expect(page).toHaveURL(new RegExp(`/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`));
      await expect(page.locator(`[data-request-id="${requestId}"]:visible`).first().getByTestId("unmet-proposal-out")).toBeVisible();
      const { data: proposals } = await service.from("proposals").select("type, status").eq("request_id", requestId);
      expect(proposals).toEqual([{ type: "alternative", status: "sent" }]);
    });

    await test.step("publishing the day is refused while the proposal is pending", async () => {
      await page.goto(paths.sadran.publish(NEVO_DEPARTMENT_ID, WEEK));
      await expect(page.getByTestId("publish-alternatives")).toBeVisible();
      await expect(page.getByTestId("publish-alternative-row")).toHaveCount(1);
      const selectDays = page.getByRole("button", { name: he.publicationFlow.selectDays, exact: true });
      await expect(selectDays).toBeEnabled();
      await selectDays.click();
      await expect(page.getByText(he.sadranPlanB.publishDayOne)).toBeVisible();
      await expect(page.getByRole("button", { name: he.publicationFlow.allYes, exact: true })).toBeDisabled();
    });
  });

  test("the member reads the proposal on /p/<token>, accepts, is served by plan B, and removing it removes the pickup too", async ({ browser }) => {
    expect(token, "the first test of this serial group sends the proposal").not.toBe("");
    const anon = await browser.newContext();
    contexts.push(anon);
    const anonPage = await anon.newPage();

    await test.step("no sign-in: the page states car, times, pickup and what is replaced", async () => {
      await anonPage.goto(paths.proposalToken(token));
      const details = anonPage.getByTestId("proposal-plan-b-details");
      await expect(details).toBeVisible();
      await expect(details.getByTestId("plan-b-car")).toContainText(CAR_NAMES.plan);
      await expect(details.getByTestId("plan-b-leave")).toContainText(PLACES.binyamina.name);
      await expect(details.getByTestId("plan-b-leave")).toContainText("09:00");
      await expect(details.getByTestId("plan-b-pickup")).toContainText(PLACES.pardesHanna.name);
      await expect(details.getByTestId("plan-b-pickup")).toContainText("17:00");
      await expect(details.getByTestId("plan-b-replaces")).toContainText(PLACES.jerusalem.name);
    });

    await test.step("accepting applies the plan B on the spot", async () => {
      await anonPage.getByRole("button", { name: t("action.acceptProposal") }).click();
      await expect(anonPage.getByTestId("proposal-plan-b-applied")).toBeVisible();

      const { data: main } = await service.from("requests").select("status, served_by_alternative, trip_type").eq("id", requestId).single();
      expect(main).toMatchObject({ served_by_alternative: true, trip_type: "drop_off" });
      const { data: siblings } = await service.from("requests").select("id, status, trip_type").eq("plan_b_parent_id", requestId);
      expect(siblings).toHaveLength(1);
      expect(siblings![0]).toMatchObject({ trip_type: "drop_off" });
    });

    const member = await newSignedInPage(browser, SEEDED_USERS.member1);
    contexts.push(member.context);
    const page = member.page;
    await page.setViewportSize({ width: 390, height: 844 });
    const { data: siblingRows } = await service.from("requests").select("id").eq("plan_b_parent_id", requestId);
    const siblingId = siblingRows![0]!.id as string;

    await test.step("/my: one item, \"שובצת בתוכנית ב׳\", the original request kept", async () => {
      await page.goto(paths.my());
      const row = page.locator(`[data-request-id="${requestId}"]`);
      await expect(row.getByTestId("request-served-by-plan-b")).toContainText(tv("planB.served", {
        place: PLACES.binyamina.name, arrive: "09:00", pickup: "17:00", pickupPlace: PLACES.pardesHanna.name,
      }));
      await expect(row.getByTestId("request-original-main")).toContainText(PLACES.jerusalem.name);
      await expect(page.locator(`[data-request-id="${siblingId}"]`)).toHaveCount(0);
    });

    await test.step("removing the request removes the linked pickup request too", async () => {
      const row = page.locator(`[data-request-id="${requestId}"]`);
      await row.getByRole("button", { name: he.requestsList.withdraw, exact: true }).click();
      const dialog = page.getByRole("dialog").filter({ hasText: he.request.withdrawConfirmTitle });
      await expect(dialog).toContainText(he.request.withdrawPlanBPickupBody);
      await dialog.getByRole("button", { name: he.requestsList.withdraw, exact: true }).click();
      await expect(dialog).toHaveCount(0);

      await expect.poll(async () => {
        const { data } = await service.from("requests").select("id, status").in("id", [requestId, siblingId]);
        return (data ?? []).map((request) => request.status).sort();
      }).toEqual(["withdrawn", "withdrawn"]);
    });
  });
});
