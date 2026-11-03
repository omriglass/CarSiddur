import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, SUPABASE_ANON_KEY, SUPABASE_URL, newSignedInPage, serviceRoleClient } from "./helpers";

// REQ §13.182 (owner 2026-11-03): the siddur's "חסר רכב" columns with the button that scrolls to them, the owner's
// private car row on every day, and "add a ride on this car" from the car card on /my.
const MEMBER1_ID = "00000000-0000-0000-0000-000000000103";
const ADMIN_ID = "00000000-0000-0000-0000-000000000101";
const RIDE_TYPE_ID = "00000000-0000-0000-0000-000000000021";
const PRIVATE_CAR_ID = "00000000-0000-0000-0000-000000000043"; // temporary, owner = member2 (seed.sql)
const PRIVATE_CAR_NAME = "רכב פרטי של חבר";
const SHARED_CAR_ID = "00000000-0000-0000-0000-000000000040";
const DISPLAY_PREFS_KEY = "siddur.display.v1";

/** A never-used Sunday (published weeks can never be deleted), Tuesday of it as the test day. */
function uniqueFutureWeek(salt: number): { weekStart: string; day: string } {
  const knownSunday = Date.UTC(2050, 0, 2);
  const weeksAhead = (Math.floor(Date.now() / 1000) % 20_000) + 30_000 + salt;
  const start = knownSunday + weeksAhead * 7 * 86_400_000;
  return { weekStart: new Date(start).toISOString().slice(0, 10), day: new Date(start + 2 * 86_400_000).toISOString().slice(0, 10) };
}

/** Every shared car blocked for the day, member1's round trip filed, then the day published: it stays waiting (no car, no group). */
async function publishedDayWithOneWaiting(salt = 1): Promise<{ weekStart: string; day: string; requestId: string }> {
  const service = serviceRoleClient();
  const { weekStart, day } = uniqueFutureWeek(salt);
  const { error: weekError } = await service.from("weeks").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
    open_at: `${weekStart}T00:00:00Z`, close_at: `${day}T00:00:00Z`, publish_at: `${day}T00:00:00Z`,
  });
  if (weekError) throw weekError;
  const { data: sharedCars, error: carsError } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active");
  if (carsError) throw carsError;
  const { error: blockError } = await service.from("car_maintenance_blocks").insert(sharedCars!.map((car) => ({
    car_id: car.id, department_id: NEVO_DEPARTMENT_ID, reason: "E2E siddur-waitlist fixture",
    starts_at: `${day}T00:00:00Z`, ends_at: `${day}T23:45:00Z`, created_by: ADMIN_ID,
  })));
  if (blockError) throw blockError;
  const { data: request, error: requestError } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, requester_id: MEMBER1_ID, filed_by: MEMBER1_ID,
    ride_type_id: RIDE_TYPE_ID, destination_text: "E2E waiting destination", trip_shape: "round_trip",
    depart_at: `${day}T09:00:00+02:00`, return_at: `${day}T11:00:00+02:00`, adults: 1, status: "submitted",
  }).select("id").single();
  if (requestError) throw requestError;

  const sadran = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error: authError } = await sadran.auth.signInWithPassword(SEEDED_USERS.sadran);
  if (authError) throw authError;
  const args = { p_department_id: NEVO_DEPARTMENT_ID, p_week_start: weekStart };
  const { data: fingerprint, error: fingerprintError } = await sadran.rpc("publish_scores_fingerprint", args);
  if (fingerprintError) throw fingerprintError;
  const { error: publishError } = await sadran.rpc("publish_siddur", {
    ...args, p_expected_fingerprint: fingerprint, p_profile_scores: [], p_policy_scores: [], p_days: [day],
  });
  if (publishError) throw publishError;
  const { data: after } = await service.from("requests").select("status").eq("id", request!.id).single();
  expect(after!.status, "the fixture request should be waiting for a car").toBe("waitlisted");
  return { weekStart, day, requestId: request!.id };
}

async function setTableView(page: Page, tableView: boolean): Promise<void> {
  await page.addInitScript(([key, table]) => {
    if (!sessionStorage.getItem("e2e-prefs-set")) {
      localStorage.setItem(key as string, JSON.stringify({ tableView: table }));
      sessionStorage.setItem("e2e-prefs-set", "1");
    }
  }, [DISPLAY_PREFS_KEY, tableView]);
}

/** Drags a grid block sideways onto a car column, at the same height (the same hours). */
async function dragOntoCar(page: Page, block: Locator, carId: string): Promise<void> {
  const column = page.locator(`[data-car-col-id="${carId}"]`).locator("visible=true");
  await column.scrollIntoViewIfNeeded();
  await block.scrollIntoViewIfNeeded();
  const from = (await block.boundingBox())!;
  const to = (await column.boundingBox())!;
  const y = from.y + Math.min(from.height / 2, 20);
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, y, { steps: 12 });
  await page.mouse.up();
}

/** How much of the element's width lies inside the grid's scroll viewport (0..1) — sideways only; a column is always taller than the screen. */
async function shownWidthShare(locator: Locator): Promise<number> {
  return locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const view = el.closest("[data-week-grid-scroll-viewport]")!.getBoundingClientRect();
    return Math.max(0, Math.min(box.right, view.right) - Math.max(box.left, view.left)) / box.width;
  });
}

test.describe("siddur waiting list", { tag: ["@waitlist", "@siddur"] }, () => {
  let fixture: { weekStart: string; day: string; requestId: string };
  test.beforeAll(async () => {
    fixture = await publishedDayWithOneWaiting();
  });

  test("the waiting request shows in the list view; the button counts it and leads to it", async ({ browser }) => {
    const viewer = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await viewer.page.setViewportSize({ width: 390, height: 844 });
      await setTableView(viewer.page, false);
      await viewer.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${fixture.weekStart}?day=${fixture.day}`);
      const button = viewer.page.getByTestId("siddur-waitlist-button").first();
      await expect(button).toBeVisible({ timeout: 15_000 });
      await expect(viewer.page.getByTestId("siddur-waitlist-count").first()).toHaveText("1");
      await expect(button).toHaveAttribute("aria-label", tv("waitlist.scrollTo", { count: "1" }));
      const card = viewer.page.getByTestId("siddur-waiting-card");
      await expect(card).toContainText(SEEDED_USERS.member1.fullName);
      await expect(card).toContainText("E2E waiting destination");

      // The button hides nothing: the card stays, in view.
      await button.click();
      await expect(card).toBeInViewport();

      // Someone else's waiting request: the details, no edit/remove.
      await card.click();
      const sheet = viewer.page.getByTestId("siddur-waiting-sheet");
      await expect(sheet.getByRole("heading", { name: he.waitlist.waitingSheetTitle })).toBeVisible();
      await expect(sheet).toContainText(SEEDED_USERS.member1.fullName);
      await expect(sheet.getByRole("link", { name: he.requestsList.edit })).toHaveCount(0);
    } finally {
      await viewer.context.close();
    }
  });

  test("table view: a \"חסר רכב\" column holds the waiting block; the button scrolls to it; the requester can edit it", async ({ browser }) => {
    const requester = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      await requester.page.setViewportSize({ width: 390, height: 844 });
      await setTableView(requester.page, true);
      await requester.page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${fixture.weekStart}?day=${fixture.day}`);
      const column = requester.page.locator('[data-car-col-id="phantom:waiting:0"]');
      await expect(column).toBeAttached({ timeout: 15_000 });
      await expect(requester.page.getByText(he.waitlist.siddurLane, { exact: true })).toBeAttached();
      // After every car; the button brings the whole column into the table's visible width.
      await requester.page.getByTestId("siddur-waitlist-button").first().click();
      await expect.poll(() => shownWidthShare(column)).toBeGreaterThan(0.95);
      const block = requester.page.locator(`[data-ride-id="waiting:${fixture.requestId}"]`);
      await expect(block).toHaveAttribute("data-kind", "waiting");
      // As for any block in the table: a tap opens the grid's preview, "פרטי הנסיעה" the sheet.
      await block.click();
      await requester.page.getByRole("button", { name: he.screen.ride.detail, exact: true }).click();
      const sheet = requester.page.getByTestId("siddur-waiting-sheet");
      await expect(sheet.getByRole("link", { name: he.requestsList.edit })).toBeVisible();
      await expect(sheet.getByRole("button", { name: he.requestsList.withdraw })).toBeVisible();
    } finally {
      await requester.context.close();
    }
  });

  test("two taps on a \"חסר רכב\" column open a new request for those hours", async ({ browser }) => {
    const member = await newSignedInPage(browser, SEEDED_USERS.member2);
    const { page } = member;
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await setTableView(page, true);
      await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${fixture.weekStart}?day=${fixture.day}`);
      const column = page.locator('[data-car-col-id="phantom:waiting:0"]').locator("visible=true");
      await expect(column).toBeVisible({ timeout: 15_000 });
      await column.scrollIntoViewIfNeeded();
      const box = (await column.boundingBox())!;
      // The grid shows 06:00–24:00: 14:00 and 16:00 are below the 09:00–11:00 waiting block.
      const yAt = (minutes: number) => ((minutes - 360) / (1440 - 360)) * box.height + 4;
      await column.click({ position: { x: box.width / 2, y: yAt(14 * 60) } });
      await column.click({ position: { x: box.width / 2, y: yAt(16 * 60) } });
      await expect(page).toHaveURL(/\/requests\/new\?.*time=14%3A00.*end=16%3A00.*waitlist=1/);
    } finally {
      await member.context.close();
    }
  });

  test("my private car has its row on a day it has no ride; other members do not see it", async ({ browser }) => {
    const owner = await newSignedInPage(browser, SEEDED_USERS.member2);
    const other = await newSignedInPage(browser, SEEDED_USERS.member1);
    try {
      for (const { page } of [owner, other]) {
        await page.setViewportSize({ width: 390, height: 844 });
        await setTableView(page, true);
        await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${fixture.weekStart}?day=${fixture.day}`);
        await expect(page.getByTestId("siddur-waitlist-button").first()).toBeVisible({ timeout: 15_000 });
      }
      await expect(owner.page.locator(`[data-car-col-id="${PRIVATE_CAR_ID}"]`)).toBeVisible();
      await expect(other.page.locator(`[data-car-col-id="${PRIVATE_CAR_ID}"]`)).toHaveCount(0);
    } finally {
      await owner.context.close();
      await other.context.close();
    }
  });

  test("/my: tapping my car offers \"add a ride on this car\", which opens the form with that car", async ({ browser }) => {
    const owner = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await owner.page.goto("/my");
      await owner.page.getByTestId(`home-car-${PRIVATE_CAR_ID}`).click();
      await expect(owner.page.getByRole("menuitem", { name: he.carPage.homeCarOpenPage })).toBeVisible();
      await owner.page.getByRole("menuitem", { name: he.carPage.homeCarAddRide }).click();
      await expect(owner.page).toHaveURL(new RegExp(`/requests/new\\?.*car=${PRIVATE_CAR_ID}`));
      await expect(owner.page.getByText(tv("request.myPrivateCar", { name: PRIVATE_CAR_NAME })).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await owner.context.close();
    }
  });
  test("dragging my waiting ride onto a car: a refusal changes nothing; on a free car it is placed", async ({ browser }) => {
    const requester = await newSignedInPage(browser, SEEDED_USERS.member1);
    const { page } = requester;
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await setTableView(page, true);
      await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${fixture.weekStart}?day=${fixture.day}`);
      const block = page.locator(`[data-ride-id="waiting:${fixture.requestId}"]`).locator("visible=true");
      await expect(block).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("edit-mode-button").locator("visible=true").click();

      // Every shared car is in maintenance that day: refused, still waiting.
      await dragOntoCar(page, block, SHARED_CAR_ID);
      await expect(page.getByText(he.waitlist.dropBlocked.maintenance).first()).toBeVisible();
      await expect(block).toBeVisible();

      // Free one car: the same drag puts the ride on it.
      await serviceRoleClient().from("car_maintenance_blocks").delete().eq("car_id", SHARED_CAR_ID).eq("reason", "E2E siddur-waitlist fixture");
      await page.reload();
      await expect(block).toBeVisible({ timeout: 15_000 });
      const pencil = page.getByTestId("edit-mode-button").locator("visible=true");
      if ((await pencil.getAttribute("data-on")) !== "true") await pencil.click();
      await dragOntoCar(page, block, SHARED_CAR_ID);
      await expect(block).toHaveCount(0, { timeout: 15_000 });
      const { data } = await serviceRoleClient().from("requests").select("status, status_reason").eq("id", fixture.requestId).single();
      expect(data).toEqual({ status: "assigned", status_reason: "MEMBER_PLACED" });
      await expect(page.locator(`[data-car-col-id="${SHARED_CAR_ID}"] [data-ride-id]`).first()).toBeVisible();
    } finally {
      await requester.context.close();
    }
  });
  test("a private car's owner gives it to someone's waiting ride from its sheet", async ({ browser }) => {
    const own = await publishedDayWithOneWaiting(2);
    const owner = await newSignedInPage(browser, SEEDED_USERS.member2);
    const { page } = owner;
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await setTableView(page, true);
      await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${own.weekStart}?day=${own.day}`);
      const block = page.locator(`[data-ride-id="waiting:${own.requestId}"]`).locator("visible=true");
      await expect(block).toBeVisible({ timeout: 15_000 });
      await block.click();
      await page.getByRole("button", { name: he.screen.ride.detail, exact: true }).click();
      await page.getByTestId("waiting-assign-my-car").click();
      await expect(block).toHaveCount(0, { timeout: 15_000 });
      const service = serviceRoleClient();
      const { data: request } = await service.from("requests").select("status, status_reason").eq("id", own.requestId).single();
      expect(request).toEqual({ status: "assigned", status_reason: "MEMBER_PLACED" });
      const { data: rides } = await service.from("ride_requests").select("rides!inner(car_id, driver_id)").eq("request_id", own.requestId);
      expect(rides?.[0]?.rides).toMatchObject({ car_id: PRIVATE_CAR_ID, driver_id: MEMBER1_ID });
    } finally {
      await owner.context.close();
    }
  });
});
