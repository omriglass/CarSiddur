import { execSync } from "node:child_process";

import { formatInTimeZone } from "date-fns-tz";
import { expect, test, type Page } from "@playwright/test";

import { NEVO_DEPARTMENT_ID, serviceRoleClient } from "./helpers";
import resetDatabase from "./global-setup";
import { he } from "../src/i18n/he";

const TZ = "Asia/Jerusalem";
/** Default selected-day range, matching the visible board. */
const GRID_START_MINUTES = 6 * 60;
const GRID_END_MINUTES = 24 * 60;

function minutesSinceMidnight(iso: string): number {
  const [h, m] = formatInTimeZone(new Date(iso), TZ, "HH:mm").split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Physical y offset (px) within a car column for a given minutes-since-midnight (`WeekGrid`'s `clampRideVertical`). */
function yForMinutes(minutes: number, colHeight: number): number {
  const clamped = Math.max(GRID_START_MINUTES, Math.min(GRID_END_MINUTES, minutes));
  return ((clamped - GRID_START_MINUTES) / (GRID_END_MINUTES - GRID_START_MINUTES)) * colHeight;
}

/** Selects the day tab (desktop `WeekStrip`) matching a given ISO instant's Jerusalem-local day. */
async function selectDayFor(page: Page, iso: string): Promise<void> {
  const dayIndex = Number(formatInTimeZone(new Date(iso), TZ, "i")) % 7; // ISO 1=Mon..7=Sun -> 0=Sun..6=Sat
  await page.getByRole("radio").nth(dayIndex).click();
  await page.waitForTimeout(300);
}

/**
 * `WeekGrid`'s own scroll container caps itself to `max-h-[70vh]`
 * (`overflow-auto`, UX_FLOWS.md §20) while a car column's *content* spans
 * the full day (`GRID_START_MINUTES`..`GRID_END_MINUTES`) — a `boundingBox()`
 * read on the column always reports that full, unclipped height, so a naive
 * `top + fraction * height` target for a later-in-the-day drop routinely
 * lands below the actual visible viewport (real, reproduced: an 11:00 drop
 * target computed this way landed at clientY 739 against a 720px-tall
 * viewport — `document.elementFromPoint` returns `null` for any point
 * outside the viewport, so the drop silently never registered). A real
 * Sadran hits the same limit — nothing here auto-scrolls the grid while a
 * drag is in progress (`docs/UX_FLOWS.md`'s "regression risk accepted" note)
 * — and would first scroll the column into view before dropping; this
 * mirrors that by scrolling the column's own `overflow-auto` ancestor so the
 * target time is centered before any pointer coordinates are computed.
 */
async function scrollGridToMinutes(page: Page, carId: string, minutes: number): Promise<void> {
  await page.locator(`[data-car-col-id="${carId}"]`).evaluate(
    (el, { minutes, gridStart, gridEnd }) => {
      const scrollParent = el.closest<HTMLElement>(".overflow-auto");
      if (!scrollParent) return;
      const fraction = (minutes - gridStart) / (gridEnd - gridStart);
      const targetOffset = fraction * el.scrollHeight;
      const desired = targetOffset - scrollParent.clientHeight / 2;
      scrollParent.scrollTop = Math.max(0, Math.min(desired, scrollParent.scrollHeight - scrollParent.clientHeight));
    },
    { minutes, gridStart: GRID_START_MINUTES, gridEnd: GRID_END_MINUTES },
  );
}

// Regression coverage for the bug-fix pass after the Sadran owner's manual
// testing (docs/UX_FLOWS.md §17). Runs against `npm run db:fake` data rather
// than the plain seed (40 realistic requests from 12 fake members) so the
// board actually has something to show — the bugs this file guards against
// (empty unmet list, "solving does nothing", auto-solve-remaining deleting
// rides) only reproduce with a non-trivial week. `test.describe.serial` +
// `db:reset` in `afterAll` isolate this file's extra data from every other
// spec (global-setup only resets once for the whole run, and file order
// otherwise is not guaranteed); `E2E_SKIP_RESET=1` runs skip that reset too,
// matching `global-setup.ts`'s own escape hatch for local iteration.
const SADRAN_EMAIL = "sadran@nevo.local";
const SADRAN_PASSWORD = "nevo-demo-1234";

async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill(SADRAN_EMAIL);
  await page.getByLabel("סיסמה").fill(SADRAN_PASSWORD);
  await page.getByRole("button", { name: "התחברות", exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
}

async function goToOpenWeek(page: Page): Promise<string> {
  await page.goto("/sadran");
  await expect(page).toHaveURL(/\/sadran\/[\w-]+\/\d{4}-\d{2}-\d{2}\/board$/);
  return page.url().replace(/\/board$/, "");
}

/** "השלם אוטומטית" now lives in the board's kebab "actions" menu (UX_FLOWS.md §4.2, 2026-09-10) at every width. */
async function openBoardActionsMenu(page: Page): Promise<void> {
  await page.getByRole("button", { name: he.sadranBoard.actionsMenu, exact: true }).click();
}

async function fillRemaining(page: Page) {
  const applied = page.waitForResponse((response) => response.url().endsWith("/rest/v1/rpc/apply_solver_result") && response.request().method() === "POST");
  await openBoardActionsMenu(page);
  await page.getByRole("menuitem", { name: he.action.autoSolveRemaining, exact: true }).click();
  expect((await applied).ok()).toBe(true);
}

function unmetCountFromHeading(text: string | null): number {
  return Number(text?.match(/\((\d+)\)/)?.[1] ?? -1);
}

test.describe.serial("board (bug-fix pass regression, fake-week data)", () => {
  test.beforeAll(() => {
    execSync("node scripts/fake-week.mjs --count 40 --clear --seed 42", { stdio: "inherit" });
  });

  test.afterAll(() => {
    resetDatabase();
  });

  test("unmet requests and phantom lanes show only the selected day, before any solve", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);

    await page.goto(`${weekUrl}/board`);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();

    // `BoardScreen.tsx`'s desktop unmet panel renders its own heading and passes
    // `showHeading={false}` to `<UnmetList>` so it doesn't render an identical one again — only
    // one "לא שובצו (N)" h2 now, but `.first()` is kept (harmless) in case a future caller of
    // `<UnmetList>` on this page ever needs its own default heading too.
    const unmetHeading = page.locator("h2:visible").filter({ hasText: /לא שובצו \(\d+\)/ }).first();
    await expect(unmetHeading).toBeVisible();
    const n = unmetCountFromHeading(await unmetHeading.textContent());
    expect(n).toBeGreaterThan(0);
    const admin = serviceRoleClient();
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
    const { data: requests } = await admin.from("requests").select("id, depart_at, return_at, trip_shape, status").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).in("status", ["submitted", "waitlisted", "proposed", "denied"]);
    for (const day of [0, 3]) {
      await page.getByRole("radio").nth(day).click();
      const expected = (requests ?? []).filter((request) => {
        const anchor = request.trip_shape === "one_way_from" ? request.return_at : request.depart_at;
        return request.status !== "denied" && anchor && Number(formatInTimeZone(new Date(anchor), TZ, "i")) % 7 === day;
      }).map((request) => `request:${request.id}`).sort();
      await expect(async () => {
        const ids = await page.locator('button[data-ride-id^="request:"]:visible').evaluateAll((elements) => elements.map((element) => element.getAttribute("data-ride-id")).sort());
        expect(ids).toEqual(expected);
      }).toPass();
    }
  });

  // Vertical-board redesign (UX_FLOWS.md §20 item 3): drag-and-drop from
  // `UnmetList` onto a car column. Runs before any solve (right after bug
  // #1's test) so the week still has plenty of unmet requests and every car
  // is genuinely free — no seat-fit/overlap conflicts to route around.
  test("drag-drop: dragging an unmet round-trip request onto a car column creates a ride there", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
    const admin = serviceRoleClient();

    const { data: cars } = await admin
      .from("cars")
      .select("id, name")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("type", "shared")
      .neq("status", "retired");
    expect(cars?.length ?? 0).toBeGreaterThan(0);
    const targetCar = cars?.[0];
    if (!targetCar) throw new Error("no shared car found");

    const { data: requests } = await admin
      .from("requests")
      .select("id, requester_id, depart_at, return_at, trip_shape, status")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("week_start", weekStart)
      .eq("trip_shape", "round_trip")
      .in("status", ["submitted", "waitlisted", "proposed", "denied"])
      .not("depart_at", "is", null)
      .not("return_at", "is", null);
    const candidate = requests?.[0];
    expect(candidate, "no unmet round-trip request found in the fake week to drag").toBeTruthy();

    await page.goto(`${weekUrl}/board`);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();
    await selectDayFor(page, candidate!.depart_at as string);

    const card = page.locator(`[data-request-id="${candidate!.id}"]:visible`);
    await expect(card).toBeVisible({ timeout: 10_000 });
    const grip = card.getByRole("button", { name: "גרור/י ללוח" });
    // `UnmetList`'s own panel is independently scrollable (bounded to match
    // `WeekGrid`'s 70vh, UX_FLOWS.md §20) — a busy week's 40+ unmet cards mean
    // this specific candidate is very often below the fold of that panel.
    await grip.scrollIntoViewIfNeeded();
    const requestedMinutes = minutesSinceMidnight(candidate!.depart_at as string);
    const dropMinutes = requestedMinutes + 15; // A nearby drop snaps back to the requested start.
    // Same reasoning on the target side: the car column's *content* spans
    // the whole day, taller than the grid's own clipped viewport, so the
    // drop time must actually be scrolled into view first — see
    // `scrollGridToMinutes`'s own doc comment.
    await scrollGridToMinutes(page, targetCar.id, dropMinutes);
    const gripBox = await grip.boundingBox();
    const colBox = await page.locator(`[data-car-col-id="${targetCar.id}"]`).boundingBox();
    if (!gripBox || !colBox) throw new Error("grip or car column not found");

    const startX = gripBox.x + gripBox.width / 2;
    const startY = gripBox.y + gripBox.height / 2;
    const endX = colBox.x + colBox.width / 2;
    const endY = colBox.y + yForMinutes(dropMinutes, colBox.height);

    // Mouse (not touch), so the drag confirms on movement past the small threshold — no long-press needed.
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 20, startY + 20, { steps: 5 });
    await page.mouse.move(endX, endY, { steps: 10 });
    await expect(page.locator("[data-drag-preview]")).toContainText(targetCar.name);
    await page.mouse.up();

    await expect(async () => {
      const { data: rideRequest } = await admin
        .from("ride_requests")
        .select("ride_id")
        .eq("request_id", candidate!.id)
        .maybeSingle();
      expect(rideRequest?.ride_id).toBeTruthy();
      const { data: ride } = await admin.from("rides").select("car_id, starts_at, ends_at").eq("id", rideRequest!.ride_id).single();
      expect(ride?.car_id).toBe(targetCar.id);
      expect(minutesSinceMidnight(ride!.starts_at)).toBe(requestedMinutes);
      expect(Date.parse(ride!.ends_at)).toBe(Date.parse(candidate!.return_at as string));
    }).toPass({ timeout: 10_000 });

    const { data: reqAfter } = await admin.from("requests").select("status").eq("id", candidate!.id).single();
    expect(reqAfter?.status).toBe("assigned");
  });

  test("bug #4: running the solver places rides on the board and the unmet count drops", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);

    await page.goto(`${weekUrl}/board`);
    const unmetHeading = page.locator("h2:visible").filter({ hasText: /לא שובצו \(\d+\)/ }).first();
    await expect(unmetHeading).toBeVisible();
    const selectedDayIndex = await page.getByRole("radio").evaluateAll((elements) => elements.findIndex((element) => element.getAttribute("aria-checked") === "true"));
    const unmetBefore = unmetCountFromHeading(await unmetHeading.textContent());
    expect(unmetBefore).toBeGreaterThan(0);

    await page.goto(weekUrl);
    await fillRemaining(page);
    // apply_solver_result + query invalidation can be slow under a busy
    // full-suite run (playwright.config.ts's own note on post-reset
    // slowness) — the default 5s assertion timeout flaked here once.
    await expect(page).toHaveURL(/\/board$/, { timeout: 15_000 });

    await page.getByRole("radio").nth(selectedDayIndex).click();

    // At least one ride block rendered on the default (busiest) day.
    const firstRide = page.locator('button[data-ride-id]:not([data-ride-id^="request:"]):visible').first();
    await expect(firstRide).toBeVisible({ timeout: 10_000 });

    // bug #3: the label is "<driver first name> ל/מ<destination>", never the department's own name.
    const label = await firstRide.getAttribute("aria-label");
    expect(label).toBeTruthy();
    expect(label).toMatch(/^\S+ [למ]\S/);
    expect(label).not.toBe("נבו");

    const unmetAfterHeading = page.locator("h2:visible").filter({ hasText: /לא שובצו \(\d+\)/ }).first();
    const unmetAfter = await unmetAfterHeading.count() ? unmetCountFromHeading(await unmetAfterHeading.textContent()) : 0;
    expect(unmetAfter).toBeLessThan(unmetBefore);
  });

  test("bug #2: moving a ride to another car via the sheet's car selector persists", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    await page.goto(`${weekUrl}/board`);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();

    const admin = serviceRoleClient();
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";

    // Restrict to `shared` cars: a `temporary` car has its own owner/relay
    // rules (`rides_temp_car_never_relays`, DATA_MODEL.md §5 #17) unrelated
    // to this bug. Pick the first ride/target-car pair that's genuinely
    // conflict-free (mirrors `BoardScreen.tsx`'s own `seatsFit`/`wouldOverlap`
    // pre-checks) rather than an arbitrary one — a real DB exclusion
    // constraint (`rides_no_overlap_per_car`) makes an arbitrary pick flaky
    // against 40 realistic fake-week rides.
    const [{ data: rides }, { data: cars }, { data: seatConfigs }, { data: rideRequests }] = await Promise.all([
      admin
        .from("rides")
        .select("id, car_id, starts_at, ends_at")
        .eq("department_id", NEVO_DEPARTMENT_ID)
        .eq("week_start", weekStart)
        .neq("status", "cancelled"),
      admin.from("cars").select("id, name").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").neq("status", "retired"),
      admin.from("car_seat_configs").select("car_id, adults, child_seats, boosters"),
      admin.from("ride_requests").select("ride_id, requests(adults, child_seats, boosters)"),
    ]);
    expect(rides?.length ?? 0).toBeGreaterThan(0);

    const passengersByRideId = new Map<string, { adults: number; child_seats: number; boosters: number }>();
    for (const rr of rideRequests ?? []) {
      const req = (Array.isArray(rr.requests) ? rr.requests[0] : rr.requests) as
        | { adults: number; child_seats: number; boosters: number }
        | null
        | undefined;
      const acc = passengersByRideId.get(rr.ride_id) ?? { adults: 0, child_seats: 0, boosters: 0 };
      acc.adults += req?.adults ?? 0;
      acc.child_seats += req?.child_seats ?? 0;
      acc.boosters += req?.boosters ?? 0;
      passengersByRideId.set(rr.ride_id, acc);
    }

    function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
      const bufferMs = 30 * 60_000;
      return Date.parse(aStart) < Date.parse(bEnd) + bufferMs && Date.parse(bStart) < Date.parse(aEnd) + bufferMs;
    }
    function fits(carId: string, need: { adults: number; child_seats: number; boosters: number }): boolean {
      const configs = (seatConfigs ?? []).filter((c) => c.car_id === carId);
      if (configs.length === 0) return true;
      return configs.some((c) => c.adults >= need.adults && c.child_seats >= need.child_seats && c.boosters >= need.boosters);
    }

    type RideRow = NonNullable<typeof rides>[number];
    let chosenRide: RideRow | undefined;
    let chosenCar: { id: string; name: string } | undefined;
    for (const ride of rides ?? []) {
      const need = passengersByRideId.get(ride.id) ?? { adults: 0, child_seats: 0, boosters: 0 };
      const candidate = (cars ?? []).find(
        (c) =>
          c.id !== ride.car_id &&
          fits(c.id, need) &&
          !(rides ?? []).some((other) => other.car_id === c.id && overlaps(ride.starts_at, ride.ends_at, other.starts_at, other.ends_at)),
      );
      if (candidate) {
        chosenRide = ride;
        chosenCar = candidate;
        break;
      }
    }
    expect(chosenRide).toBeTruthy();
    expect(chosenCar).toBeTruthy();

    const rideLocator = page.locator(`button[data-ride-id="${chosenRide?.id}"]:visible`);
    // The chosen ride may be on a different day than the board's default — walk day tabs until it's visible.
    for (const dayIndex of [0, 1, 2, 3, 4, 5, 6]) {
      if (await rideLocator.isVisible()) break;
      await page.getByRole("radio").nth(dayIndex).click();
      await page.waitForTimeout(300);
    }
    await expect(rideLocator).toBeVisible({ timeout: 10_000 });
    await rideLocator.click();
    await expect(page.getByRole("heading", { name: "פרטי הנסיעה" })).toBeVisible();

    // "העבר לרכב" select (bug #2's no-drag/touch fallback).
    await page.getByRole("combobox").last().click();
    await page.getByRole("option", { name: chosenCar?.name, exact: true }).click();
    await page.getByRole("button", { name: "שמור שינויים" }).click();
    await expect(page.getByRole("heading", { name: "פרטי הנסיעה" })).toBeHidden({ timeout: 10_000 });

    const { data: after } = await admin.from("rides").select("car_id, is_pinned").eq("id", chosenRide?.id as string).single();
    expect(after?.car_id).toBe(chosenCar?.id);
    // Manual edits auto-pin (REQUIREMENTS §7.1) — otherwise the very next
    // re-solve could delete this ride (bug #5).
    expect(after?.is_pinned).toBe(true);
  });

  // Vertical-board redesign (UX_FLOWS.md §20 item 4): moving a ride between
  // cars is now a *horizontal* pointer drag (car columns side by side, time
  // flows top→bottom). Dropping at the exact same on-screen y as the ride's
  // own block keeps the vertical (time) delta at ~0, which the dead zone
  // (`snapTimeShift`) rounds to exactly 0 — a pure car change never shifts
  // the time, mirroring `WeekGrid.test.ts`'s own coverage of that math.
  test("drag-drop: dragging a ride horizontally to another car column keeps its start/end times", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    await page.goto(`${weekUrl}/board`);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();

    const admin = serviceRoleClient();
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";

    const [{ data: rides }, { data: cars }, { data: seatConfigs }, { data: rideRequests }] = await Promise.all([
      admin
        .from("rides")
        .select("id, car_id, starts_at, ends_at")
        .eq("department_id", NEVO_DEPARTMENT_ID)
        .eq("week_start", weekStart)
        .neq("status", "cancelled"),
      admin.from("cars").select("id, name").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").neq("status", "retired"),
      admin.from("car_seat_configs").select("car_id, adults, child_seats, boosters"),
      admin.from("ride_requests").select("ride_id, requests(adults, child_seats, boosters)"),
    ]);
    expect(rides?.length ?? 0).toBeGreaterThan(0);

    const passengersByRideId = new Map<string, { adults: number; child_seats: number; boosters: number }>();
    for (const rr of rideRequests ?? []) {
      const req = (Array.isArray(rr.requests) ? rr.requests[0] : rr.requests) as
        | { adults: number; child_seats: number; boosters: number }
        | null
        | undefined;
      const acc = passengersByRideId.get(rr.ride_id) ?? { adults: 0, child_seats: 0, boosters: 0 };
      acc.adults += req?.adults ?? 0;
      acc.child_seats += req?.child_seats ?? 0;
      acc.boosters += req?.boosters ?? 0;
      passengersByRideId.set(rr.ride_id, acc);
    }
    function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
      const bufferMs = 30 * 60_000;
      return Date.parse(aStart) < Date.parse(bEnd) + bufferMs && Date.parse(bStart) < Date.parse(aEnd) + bufferMs;
    }
    function fits(carId: string, need: { adults: number; child_seats: number; boosters: number }): boolean {
      const configs = (seatConfigs ?? []).filter((c) => c.car_id === carId);
      if (configs.length === 0) return true;
      return configs.some((c) => c.adults >= need.adults && c.child_seats >= need.child_seats && c.boosters >= need.boosters);
    }

    type RideRow = NonNullable<typeof rides>[number];
    let chosenRide: RideRow | undefined;
    let chosenCar: { id: string; name: string } | undefined;
    for (const ride of rides ?? []) {
      const need = passengersByRideId.get(ride.id) ?? { adults: 0, child_seats: 0, boosters: 0 };
      const candidate = (cars ?? []).find(
        (c) =>
          c.id !== ride.car_id &&
          fits(c.id, need) &&
          !(rides ?? []).some((other) => other.car_id === c.id && overlaps(ride.starts_at, ride.ends_at, other.starts_at, other.ends_at)),
      );
      if (candidate) {
        chosenRide = ride;
        chosenCar = candidate;
        break;
      }
    }
    expect(chosenRide).toBeTruthy();
    expect(chosenCar).toBeTruthy();

    await selectDayFor(page, chosenRide!.starts_at);
    const rideLocator = page.locator(`button[data-ride-id="${chosenRide?.id}"]:visible`);
    await expect(rideLocator).toBeVisible({ timeout: 10_000 });
    // `toBeVisible()` only asserts CSS visibility, not that the block sits
    // within `WeekGrid`'s own clipped `max-h-[70vh]` scrollport (see
    // `scrollGridToMinutes`'s doc comment) — a ride later in the day is
    // routinely rendered well below the fold, at a `boundingBox()` y beyond
    // the browser viewport entirely, which no synthetic pointer event can
    // land on.
    await rideLocator.scrollIntoViewIfNeeded();

    const rideBox = await rideLocator.boundingBox();
    const targetColBox = await page.locator(`[data-car-col-id="${chosenCar!.id}"]`).boundingBox();
    if (!rideBox || !targetColBox) throw new Error("ride block or target car column not found");

    const startX = rideBox.x + rideBox.width / 2;
    const startY = rideBox.y + rideBox.height / 2;
    const endX = targetColBox.x + targetColBox.width / 2;
    // Same y as the source block -> ~0 vertical (time) delta, snapped to exactly 0 by the dead zone.
    const endY = startY;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + Math.sign(endX - startX) * 20, startY, { steps: 5 });
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();

    await expect(async () => {
      const { data: after } = await admin
        .from("rides")
        .select("car_id, starts_at, ends_at, is_pinned")
        .eq("id", chosenRide!.id)
        .single();
      expect(after?.car_id).toBe(chosenCar!.id);
      expect(after?.starts_at).toBe(chosenRide!.starts_at);
      expect(after?.ends_at).toBe(chosenRide!.ends_at);
      expect(after?.is_pinned).toBe(true);
    }).toPass({ timeout: 10_000 });
  });

  test("bug #5: auto-solve remaining after a manual move never deletes existing rides", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    await page.goto(`${weekUrl}/board`);
    await expect(page.getByRole("heading", { name: "לוח הסידור" })).toBeVisible();

    const admin = serviceRoleClient();
    const { data: beforeRides } = await admin
      .from("rides")
      .select("id")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("week_start", weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "")
      .neq("status", "cancelled");
    const beforeIds = new Set((beforeRides ?? []).map((r) => r.id));
    expect(beforeIds.size).toBeGreaterThan(0);

    await openBoardActionsMenu(page);
    await page.getByRole("menuitem", { name: "השלם אוטומטית", exact: true }).click();
    await page.waitForTimeout(2000);

    const { data: afterRides } = await admin
      .from("rides")
      .select("id")
      .eq("department_id", NEVO_DEPARTMENT_ID)
      .eq("week_start", weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "")
      .neq("status", "cancelled");
    const afterIds = new Set((afterRides ?? []).map((r) => r.id));

    // Every ride that existed before "auto-solve remaining" must still exist
    // after it — it may only *add* rides for requests that were still open.
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
    expect(afterIds.size).toBeGreaterThanOrEqual(beforeIds.size);
  });

  // MAJOR BUG investigation (docs/UX_FLOWS.md §19): owner report after bug
  // #5's fix shipped — "clicking Solve and Autofill STILL sometimes makes
  // certain rides disappear." Root cause was `gatherSolverContext` (now
  // `applySolve.ts`) deciding which requests were "open" for the solver by
  // status alone, independently of which rides were `fixedRides` — a
  // request already assigned by a *previous solve's own unpinned ride* was
  // invisible to the solver on the *next* solve, so a full re-solve deleted
  // its ride without ever being asked to replace it. Fixed by (1) reopening
  // any request whose current ride is not fixed, regardless of status, and
  // (2) making the primary "Solve" action ("הרץ פותר") always run in
  // `'remaining'` mode, which can only ever add rides, never delete any.
  test("MAJOR BUG regression: Solve -> Apply, then Solve -> Apply again with no changes, never loses a ride or an assignment", async ({
    page,
  }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
    const admin = serviceRoleClient();

    async function snapshot() {
      const [{ data: rides }, { data: requests }] = await Promise.all([
        admin
          .from("rides")
          .select("id")
          .eq("department_id", NEVO_DEPARTMENT_ID)
          .eq("week_start", weekStart)
          .neq("status", "cancelled"),
        admin
          .from("requests")
          .select("id, status")
          .eq("department_id", NEVO_DEPARTMENT_ID)
          .eq("week_start", weekStart)
          .in("status", ["assigned", "merged"]),
      ]);
      return {
        rideIds: new Set((rides ?? []).map((r) => r.id as string)),
        assignedOrMerged: new Map((requests ?? []).map((r) => [r.id as string, r.status as string])),
      };
    }

    async function solveAndApply() {
      await page.goto(weekUrl);
      await fillRemaining(page);
      await expect(page).toHaveURL(/\/board$/, { timeout: 15_000 });
    }

    // First round: whatever this week's current state is.
    await solveAndApply();
    const afterFirst = await snapshot();

    // Second round, sequence (a): Solve -> Apply again with (ideally)
    // nothing new to place — this is exactly where the bug reproduced.
    await solveAndApply();
    const afterSecond = await snapshot();

    for (const id of afterFirst.rideIds) {
      expect(afterSecond.rideIds.has(id), `ride ${id} present after the first apply disappeared after the second`).toBe(
        true,
      );
    }
    for (const [requestId, statusBefore] of afterFirst.assignedOrMerged) {
      const statusAfter = afterSecond.assignedOrMerged.get(requestId);
      expect(
        statusAfter,
        `request ${requestId} was ${statusBefore} after the first apply but lost its assignment after the second`,
      ).toBe(statusBefore);
    }
  });
  test("free-text reservations persist, resize their end, and can be removed", async ({ page }) => {
    await signIn(page);
    const weekUrl = await goToOpenWeek(page);
    const weekStart = weekUrl.match(/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? "";
    const admin = serviceRoleClient();
    const { error: cleanupError } = await admin.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).eq("notes", "Board regression reservation");
    expect(cleanupError).toBeNull();
    await page.goto(`${weekUrl}/board`);
    await page.getByRole("radio").first().click();
    // "show early hours" now lives only in the board's "eye" display menu (UX_FLOWS.md §4.2, 2026-09-10), at every width.
    await page.getByRole("button", { name: he.sadranBoard.displayMenu, exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: he.board.showEarlyHours, exact: true }).click();
    await page.keyboard.press("Escape");
    const column = page.locator('[data-car-col-id]:not([data-car-col-id^="phantom:"]):visible').first();
    await column.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".overflow-auto");
      if (scroller) scroller.scrollTop = 0;
    });
    const columnBox = await column.boundingBox();
    if (!columnBox) throw new Error("car column not found");
    await column.click({ position: { x: columnBox.width / 2, y: 30 / 1440 * columnBox.height } });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("יציאה", { exact: true }).fill("00:30");
    await dialog.getByLabel("חזרה", { exact: true }).fill("01:30");
    await dialog.getByLabel("תיאור השמירה — יוצג בלוח").fill("Board regression reservation");
    await dialog.getByRole("button", { name: "שמירה", exact: true }).click();
    await expect(dialog).toBeHidden();
    const { data: reserved, error } = await admin.from("rides").select("id, starts_at, ends_at, driver_id").eq("week_start", weekStart).eq("notes", "Board regression reservation").single();
    expect(error).toBeNull();
    expect(reserved?.driver_id).toBeNull();
    const block = page.locator(`button[data-ride-id="${reserved!.id}"]:visible`);
    await block.scrollIntoViewIfNeeded();
    const edge = block.locator(".bottom-0");
    const box = await edge.boundingBox();
    if (!box) throw new Error("reservation resize edge missing");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20, { steps: 5 });
    await expect(page.locator("[data-drag-preview]")).toContainText("00:30–01:45");
    await page.mouse.up();
    await expect(async () => {
      const { data: after } = await admin.from("rides").select("starts_at, ends_at").eq("id", reserved!.id).single();
      expect(after?.starts_at).toBe(reserved?.starts_at);
      expect(minutesSinceMidnight(after!.ends_at)).toBe(105);
    }).toPass();
    await expect(block).toContainText("00:30–01:45");
    await block.click();
    await page.getByRole("button", { name: "הסר שיבוץ" }).click();
    await expect(block).toHaveCount(0);
  });

});
