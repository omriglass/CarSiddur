import { expect, test, type Page } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn, submitRequestForm } from "./helpers";
import {
  chooseDestination, dayOfWeek, deleteRequests, fillTimeField, jerusalemTime, memberOpenWeek, PLACES, pickPlace, PROFILE_IDS,
  saveEditedRequest, setClassicForm,
} from "./request-form";

// REQ §13.112 (a)/(b)/(e), UX_FLOWS §3.4a "אם אין רכב…" and §3.4 "+ תוכנית ב׳": the member's plan B on the request form.
//  - sentence form: a הקפצה to a drop point with a pickup from ANOTHER place, stored in `request_alternatives`, shown on /my;
//    "אסתדר" stored as `fallback = 'manage'`; switching the main trip to הקפצה uses plan B (and switching back restores the
//    trip), without a plan B the "במקום … הקפצה ל…" dialog asks for it;
//  - classic form: its own "+ תוכנית ב׳" section saves, reopens, and shows no error before a submit attempt.
test.use({ viewport: { width: 390, height: 844 } });

async function openNewForm(page: Page, week: string, day: string): Promise<void> {
  await page.goto(paths.requests.new({ week, day }));
  await expect(page.getByTestId("request-sentence")).toBeVisible();
}

async function describeWith(page: Page, marker: string): Promise<void> {
  await page.getByTestId("stage-one-notes").getByTestId("row-description").getByRole("button").click();
  await page.getByRole("textbox", { name: he.requestSentence.description }).fill(marker);
}

test.describe("plan B on the sentence form", { tag: ["@request-form"] }, () => {
  test.beforeEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, false); });
  test.afterEach(async () => { await setClassicForm(SEEDED_USERS.member2.email, true); });

  test("a הקפצה plan B with another pickup place is stored and shown on /my; \"אסתדר\" replaces it", async ({ page }) => {
    test.slow();
    const service = serviceRoleClient();
    const week = await memberOpenWeek();
    const day = dayOfWeek(week.weekStart, 2);
    const marker = `E2E plan B ${Date.now()}`;
    let requestId: string | undefined;
    try {
      await signIn(page, SEEDED_USERS.member2);
      await openNewForm(page, week.weekStart, day);
      await chooseDestination(page, PLACES.haifa.name);

      await test.step("add the line: drop point, be-there-by time, pickup from another drop point", async () => {
        await page.getByTestId("plan-b-link").click();
        await expect(page.getByTestId("plan-b-line")).toBeVisible();
        await expect(page.getByTestId("chip-plan-b-kind")).toHaveText(he.planB.kind.alternative);

        await page.getByTestId("chip-plan-b-place").click();
        await pickPlace(page, he.planB.placeSearch, PLACES.binyamina.name);
        await expect(page.getByTestId("chip-plan-b-place")).toContainText(PLACES.binyamina.name);

        await page.getByTestId("chip-plan-b-arrive").click();
        await fillTimeField(page.getByTestId("plan-b-arrive-sheet"), he.planB.sheet.arrive, "09:15");
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await expect(page.getByTestId("chip-plan-b-arrive")).toContainText("09:15");

        await page.getByTestId("chip-plan-b-pickup-place").click();
        await pickPlace(page, he.planB.placeSearch, PLACES.pardesHanna.name);
        await expect(page.getByTestId("chip-plan-b-pickup-place")).toContainText(PLACES.pardesHanna.name);
      });

      let pickupTime = "";
      await test.step("stage 2 recap and submit", async () => {
        pickupTime = /(\d{1,2}:\d{2})/.exec(await page.getByTestId("chip-plan-b-pickup").innerText())?.[1] ?? "";
        expect(pickupTime).not.toBe("");
        await describeWith(page, marker);
        await page.getByTestId("stage-next").click();
        await expect(page.getByTestId("recap-plan-b")).toContainText(tv("planB.recapPickupFrom", {
          place: PLACES.binyamina.name, arrive: "09:15", pickup: pickupTime, pickupPlace: PLACES.pardesHanna.name,
        }));
        await submitRequestForm(page);
        await expect(page).toHaveURL(/\/my$/);
      });

      await test.step("stored in request_alternatives", async () => {
        const { data: request, error } = await service.from("requests").select("id, fallback")
          .eq("requester_id", PROFILE_IDS.member2).eq("ride_description", marker).single();
        if (error) throw error;
        requestId = request.id as string;
        expect(request.fallback).toBe("alternative");
        const { data: alt } = await service.from("request_alternatives")
          .select("drop_place_id, arrive_by, pickup, pickup_at, pickup_place_id").eq("request_id", requestId).single();
        expect(alt).toMatchObject({ drop_place_id: PLACES.binyamina.id, pickup: true, pickup_place_id: PLACES.pardesHanna.id });
        expect(jerusalemTime(alt!.arrive_by as string)).toBe("09:15");
        expect(jerusalemTime(alt!.pickup_at as string)).toBe(pickupTime.padStart(5, "0"));
      });

      await test.step("/my shows the plan-B line", async () => {
        await expect(page.locator(`[data-request-id="${requestId}"]`).getByTestId("request-plan-b")).toContainText(tv("planB.myLinePickupFrom", {
          place: PLACES.binyamina.name, arrive: "09:15", pickup: pickupTime, pickupPlace: PLACES.pardesHanna.name,
        }));
      });

      await test.step("the edit reopens with the line; \"אסתדר\" is stored as fallback = manage", async () => {
        await page.goto(paths.requests.edit(requestId as string));
        await expect(page.getByTestId("chip-plan-b-place")).toContainText(PLACES.binyamina.name);
        await page.getByTestId("chip-plan-b-kind").click();
        await page.getByTestId("plan-b-option-manage").click();
        await expect(page.getByTestId("chip-plan-b-kind")).toHaveText(he.planB.kind.manage);
        await saveEditedRequest(page);

        await expect(page).toHaveURL(/\/my$/);
        const { data: request } = await service.from("requests").select("fallback").eq("id", requestId as string).single();
        expect(request!.fallback).toBe("manage");
        await expect(page.locator(`[data-request-id="${requestId}"]`).getByTestId("request-plan-b")).toContainText(he.planB.myLineManage);
      });
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      else await service.from("requests").delete().eq("requester_id", PROFILE_IDS.member2).eq("ride_description", marker);
      await week.cleanup();
    }
  });

  test("switching the main trip to הקפצה uses plan B and switching back restores it", async ({ page }) => {
    const week = await memberOpenWeek();
    try {
      await signIn(page, SEEDED_USERS.member2);
      await openNewForm(page, week.weekStart, dayOfWeek(week.weekStart, 3));
      await chooseDestination(page, PLACES.haifa.name);
      await page.getByTestId("plan-b-link").click();
      await page.getByTestId("chip-plan-b-place").click();
      await pickPlace(page, he.planB.placeSearch, PLACES.binyamina.name);

      await test.step("הקפצה: the drop point becomes the destination", async () => {
        await page.getByTestId("chip-trip").click();
        await page.getByRole("radio", { name: he.request.tripTypeDropOff, exact: true }).click();
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await expect(page.getByRole("dialog", { name: he.requestSentence.sheet.trip })).toHaveCount(0);
        await expect(page.getByTestId("chip-trip")).toContainText(he.request.tripTypeDropOff);
        await expect(page.getByTestId("chip-destination")).toContainText(PLACES.binyamina.name);
        // a הקפצה carries no "if there is no car" line of its own
        await expect(page.getByTestId("plan-b")).toHaveCount(0);
      });

      await test.step("back to הלוך-חזור: the trip and plan B are restored", async () => {
        await page.getByTestId("chip-trip").click();
        await page.getByRole("radio", { name: he.request.tripTypeRoundTrip, exact: true }).click();
        await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
        await expect(page.getByTestId("chip-trip")).toHaveText(he.request.tripTypeRoundTrip);
        await expect(page.getByTestId("chip-destination")).toContainText(PLACES.haifa.name);
        await expect(page.getByTestId("chip-plan-b-place")).toContainText(PLACES.binyamina.name);
      });
    } finally {
      await week.cleanup();
    }
  });

  test("without a plan B the switch asks \"במקום … הקפצה ל…\" and then applies it", async ({ page }) => {
    const week = await memberOpenWeek();
    try {
      await signIn(page, SEEDED_USERS.member2);
      await openNewForm(page, week.weekStart, dayOfWeek(week.weekStart, 3));
      await chooseDestination(page, PLACES.haifa.name);

      await page.getByTestId("chip-trip").click();
      await page.getByRole("radio", { name: he.request.tripTypeDropOff, exact: true }).click();

      const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("drop-off-switch-dialog") });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(tv("planB.switch.instead", { trip: tv("planB.originalRoute", { trip: he.request.tripTypeRoundTrip, destination: PLACES.haifa.name }) }));
      await dialog.getByTestId("drop-off-switch-place").click();
      await pickPlace(page, he.planB.placeSearch, PLACES.binyamina.name);
      await dialog.getByRole("button", { name: he.planB.switch.confirm, exact: true }).click();
      await expect(dialog).toHaveCount(0);

      await page.getByRole("button", { name: he.requestSentence.sheetDone, exact: true }).click();
      await expect(page.getByTestId("chip-trip")).toContainText(he.request.tripTypeDropOff);
      await expect(page.getByTestId("chip-destination")).toContainText(PLACES.binyamina.name);
    } finally {
      await week.cleanup();
    }
  });
});

test.describe("plan B on the classic form", { tag: ["@request-form"] }, () => {
  test("\"+ תוכנית ב׳\" saves and reopens, with no error before a submit attempt", async ({ page }) => {
    const service = serviceRoleClient();
    const week = await memberOpenWeek();
    const marker = `E2E classic plan B ${Date.now()}`;
    let requestId: string | undefined;
    try {
      await signIn(page, SEEDED_USERS.member1);
      await page.goto(paths.requests.new({ week: week.weekStart, day: dayOfWeek(week.weekStart, 3) }));
      await expect(page.getByTestId("request-sentence")).toHaveCount(0);

      await page.getByRole("combobox").filter({ hasText: he.field.destination }).click();
      await page.getByPlaceholder(he.field.destination).fill(PLACES.haifa.name);
      await page.getByRole("option").filter({ hasText: PLACES.haifa.name }).first().click();
      await page.getByRole("radiogroup", { name: he.field.rideType }).getByRole("radio").first().click();
      await page.getByRole("textbox", { name: he.quickRequest.rideDescription }).fill(marker);

      await test.step("opening the section shows no error before a submit attempt", async () => {
        await page.getByTestId("plan-b-link").click();
        await expect(page.getByTestId("plan-b-option-alternative")).toHaveAttribute("aria-checked", "true");
        await expect(page.getByText(he.planB.error.placeRequired)).toHaveCount(0);
        await expect(page.getByText(he.planB.error.arriveRequired)).toHaveCount(0);
      });

      await test.step("fill the drop point and the time, submit", async () => {
        await page.getByTestId("plan-b").getByRole("combobox").first().click();
        await page.getByPlaceholder(he.planB.placeEmpty).fill(PLACES.binyamina.name);
        await page.getByRole("option").filter({ hasText: PLACES.binyamina.name }).first().click();
        await fillTimeField(page, he.planB.classic.arrive, "09:30");
        await submitRequestForm(page);
        await expect(page).toHaveURL(/\/my$/);
      });

      await test.step("stored, then the edit reopens expanded", async () => {
        const { data: request, error } = await service.from("requests").select("id, fallback")
          .eq("requester_id", PROFILE_IDS.member1).eq("ride_description", marker).single();
        if (error) throw error;
        requestId = request.id as string;
        expect(request.fallback).toBe("alternative");
        const { data: alt } = await service.from("request_alternatives").select("drop_place_id, arrive_by, pickup").eq("request_id", requestId).single();
        expect(alt).toMatchObject({ drop_place_id: PLACES.binyamina.id, pickup: true });
        expect(jerusalemTime(alt!.arrive_by as string)).toBe("09:30");

        await page.goto(paths.requests.edit(requestId));
        await expect(page.getByTestId("plan-b-option-alternative")).toHaveAttribute("aria-checked", "true");
        await expect(page.getByTestId("plan-b").getByRole("combobox").first()).toContainText(PLACES.binyamina.name);
        await expect(page.getByLabel(he.planB.classic.arrive, { exact: true })).toHaveValue("09:30");
        await expect(page.getByText(he.planB.error.placeRequired)).toHaveCount(0);
      });
    } finally {
      if (requestId) await deleteRequests(service, [requestId]);
      else await service.from("requests").delete().eq("requester_id", PROFILE_IDS.member1).eq("ride_description", marker);
      await week.cleanup();
    }
  });
});
