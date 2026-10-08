import type { SupabaseClient } from "@supabase/supabase-js";
import { expect, type Locator, type Page } from "@playwright/test";
import { formatInTimeZone } from "date-fns-tz";

import { he } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, serviceRoleClient } from "./helpers";

// Shared plumbing of the request-form / plan-B / large-trunk specs (REQ §13.110–§13.112): seeded ids,
// the layout switch of a demo account, the member-facing "open week", fixture weeks that the specs own,
// and the few multi-step UI interactions several specs repeat (place sheets, saving an edit, board drag).
// Everything here is local-stack test plumbing; the behaviour under test always goes through the UI.

export const TZ = "Asia/Jerusalem";

/** Profile ids of the four demo accounts (`supabase/seed.sql`). */
export const PROFILE_IDS = {
  admin: "00000000-0000-0000-0000-000000000101",
  sadran: "00000000-0000-0000-0000-000000000102",
  member1: "00000000-0000-0000-0000-000000000103",
  member2: "00000000-0000-0000-0000-000000000104",
} as const;

/** Seeded places (`destinations`); the drop points of the demo department are Binyamina, Zichron Yaakov and Pardes Hanna. */
export const PLACES = {
  home: { id: "00000000-0000-0000-0000-000000000010", name: "גבעת חביבה" },
  haifa: { id: "00000000-0000-0000-0000-000000000011", name: "חיפה" },
  binyamina: { id: "00000000-0000-0000-0000-000000000012", name: "בנימינה" },
  zichron: { id: "00000000-0000-0000-0000-000000000013", name: "זכרון יעקב" },
  afula: { id: "00000000-0000-0000-0000-000000000016", name: "עפולה" },
  pardesHanna: { id: "00000000-0000-0000-0000-000000000017", name: "פרדס חנה" },
  jerusalem: { id: "00000000-0000-0000-0000-000000000019", name: "ירושלים" },
} as const;

export const RIDE_TYPE_WORK = "00000000-0000-0000-0000-000000000021";

/** Far-future winter weeks (UTC+2, no DST) that each spec owns exclusively; all are Sundays. */
export const FIXTURE_WEEKS = {
  publishedEdit: "2045-01-08",
  planBCycle: "2045-01-15",
  largeTrunk: "2045-01-22",
  memberFallback: "2045-01-29",
} as const;

/** `yyyy-MM-dd` of the `index`-th day (0 = Sunday) of a week. */
export function dayOfWeek(weekStart: string, index: number): string {
  return new Date(Date.parse(`${weekStart}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
}

/** "HH:mm" in Jerusalem of a stored instant. */
export function jerusalemTime(instant: string): string {
  return formatInTimeZone(new Date(instant), TZ, "HH:mm");
}

/** The stored instant of a local winter time of a fixture day (UTC+2). */
export function winterAt(day: string, time: string): string {
  return `${day}T${time}:00+02:00`;
}

/** `d.M` as the date chips print it ("ד׳ 15.10" -> "15.10"): day and month without leading zeros. */
export function dayMonthLabel(day: string): string {
  return `${Number(day.slice(8, 10))}.${Number(day.slice(5, 7))}`;
}

/** Flip a demo account between the sentence layout (`false`) and the classic form (`true`, the suite default). */
export async function setClassicForm(email: string, classic: boolean): Promise<void> {
  const { error } = await serviceRoleClient().from("profiles").update({ classic_request_form: classic }).eq("email", email);
  if (error) throw error;
}

export interface MemberWeek {
  weekStart: string;
  /** Removes the fixture week again when this helper had to create it (no-op for the seeded open week). */
  cleanup: () => Promise<void>;
}

/**
 * The week a member can file requests into. The seeded open week when it still accepts requests; otherwise (an
 * earlier spec published it) a far-future open week with a permanent window that this helper creates and removes.
 */
export async function memberOpenWeek(): Promise<MemberWeek> {
  const service = serviceRoleClient();
  try {
    const weekStart = await getWeekStart("open");
    const { data } = await service.from("weeks").select("open_at, close_at").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart).single();
    if (data && Date.parse(data.open_at) <= Date.now() && Date.parse(data.close_at) > Date.now()) {
      return { weekStart, cleanup: async () => undefined };
    }
  } catch { /* no open week: fall through to the fixture */ }
  const weekStart = FIXTURE_WEEKS.memberFallback;
  await removeWeek(service, weekStart);
  const { error } = await service.from("weeks").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
    open_at: "2000-01-01T00:00:00Z", close_at: "2090-01-01T00:00:00Z", publish_at: "2090-01-02T00:00:00Z",
  });
  if (error) throw error;
  return { weekStart, cleanup: () => removeWeek(service, weekStart) };
}

/** Creates (or resets) an unpublished week the Sadran can work on; members' windows are irrelevant there. */
export async function ensureUnpublishedWeek(service: SupabaseClient, week: string, phase: "open" | "solving" = "solving"): Promise<void> {
  await removeWeek(service, week);
  const at = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86_400_000).toISOString();
  const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase, open_at: at(7), close_at: at(3), publish_at: at(2) });
  if (error) throw error;
}

/** Deletes everything a spec created in one fixture week (rides, requests, proposals, notifications) and the week row itself. */
export async function removeWeek(service: SupabaseClient, week: string, options: { keepWeek?: boolean } = {}): Promise<void> {
  const scope = { department_id: NEVO_DEPARTMENT_ID, week_start: week };
  await service.from("proposals").delete().match(scope);
  const { data: rides } = await service.from("rides").select("id").match(scope);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("ride_change_requests").delete().match(scope);
  await service.from("rides").delete().match(scope);
  await service.from("request_alternatives").delete().match(scope);
  // A plan-B pickup sibling points at its parent: remove the children first.
  await service.from("requests").delete().match(scope).not("plan_b_parent_id", "is", null);
  await service.from("requests").delete().match(scope);
  await service.from("notifications").delete().match(scope);
  if (!options.keepWeek) await service.from("weeks").delete().match(scope);
}

export async function deleteRequests(service: SupabaseClient, ids: readonly string[]): Promise<void> {
  if (!ids.length) return;
  const { data: links } = await service.from("ride_requests").select("ride_id").in("request_id", ids);
  const rideIds = [...new Set((links ?? []).map((link) => link.ride_id as string))];
  await service.from("proposals").delete().in("request_id", ids);
  await service.from("ride_requests").delete().in("request_id", ids);
  if (rideIds.length) await service.from("rides").delete().in("id", rideIds);
  await service.from("requests").delete().in("plan_b_parent_id", ids);
  await service.from("requests").delete().in("id", ids);
}

export interface InsertRequestInput {
  week: string;
  requester: string;
  /** Jerusalem "HH:mm" on the request's day. */
  depart: string;
  return: string;
  destinationId?: string;
  destinationText?: string;
  status?: string;
  flex?: string;
  hasLuggage?: boolean;
  notes?: string;
  extra?: Record<string, unknown>;
}

/** Inserts a single-day round-trip request straight into the table (setup only), times are Jerusalem "HH:mm" on `day`. */
export async function insertRequest(service: SupabaseClient, day: string, input: InsertRequestInput): Promise<string> {
  const flex = input.flex ?? "00:00:00";
  const { data, error } = await service.from("requests").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: input.week, requester_id: input.requester, filed_by: input.requester,
    ride_type_id: RIDE_TYPE_WORK,
    ...(input.destinationId ? { destination_id: input.destinationId } : { destination_text: input.destinationText }),
    trip_shape: "round_trip", trip_type: "round_trip",
    depart_at: winterAt(day, input.depart), return_at: winterAt(day, input.return),
    flex_depart_early: flex, flex_depart_late: flex, flex_return_early: flex, flex_return_late: flex,
    has_luggage: input.hasLuggage ?? false, notes: input.notes ?? null,
    status: input.status ?? "submitted", submitted_at: new Date().toISOString(),
    ...(input.extra ?? {}),
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

/** A car-time reservation (a ride with no served request): holds the car and nothing else. */
export async function reserveCar(service: SupabaseClient, week: string, carId: string, day: string, start: string, end: string): Promise<string> {
  const endIso = winterAt(day, end);
  const { data, error } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, created_by: PROFILE_IDS.sadran,
    starts_at: winterAt(day, start), ends_at: endIso,
    blocked_until: new Date(Date.parse(endIso) + 30 * 60_000).toISOString(),
    origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "draft", notes: "E2E reservation",
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function sharedCarIdByName(service: SupabaseClient, name: string): Promise<string> {
  const { data, error } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("name", name).single();
  if (error) throw error;
  return data.id as string;
}

/** Search a place sheet / inline list and tap the first row that names the place. */
export async function pickPlace(page: Page, searchPlaceholder: string, place: string): Promise<void> {
  await page.getByPlaceholder(searchPlaceholder).fill(place);
  await page.getByRole("option").filter({ hasText: place }).first().click();
}

/** Sentence form: open the destination chip's sheet and pick a seeded place. */
export async function chooseDestination(page: Page, place: string): Promise<void> {
  await page.getByTestId("chip-destination").click();
  await pickPlace(page, he.requestSentence.placeSearch, place);
  await expect(page.getByTestId("chip-destination")).toContainText(place);
}

/** Sentence form, stage 1 -> 2 -> "שמור/י שינויים"; answers the overlap dialog with "keep both" when it opens. */
export async function saveEditedRequest(page: Page): Promise<void> {
  const next = page.getByTestId("stage-next");
  if (await next.isVisible()) {
    await next.click();
    await page.getByTestId("stage-two").waitFor({ state: "visible" });
  }
  await page.getByRole("button", { name: he.action.saveRequest, exact: true }).click();
  const keepBoth = page.getByRole("dialog", { name: he.request.overlapTitle }).getByRole("button", { name: he.request.overlapKeepBoth });
  await keepBoth.waitFor({ state: "visible", timeout: 2_000 }).then(() => keepBoth.click(), () => undefined);
}

/** Sets a 15-minute time field inside a sheet (`root` scopes the label): type the digits, blur to commit. */
export async function fillTimeField(root: Page | Locator, label: string, time: string): Promise<void> {
  const field = root.getByLabel(label, { exact: true });
  await field.fill(time);
  await field.blur();
}

/**
 * Drags an unmet request card onto a car column of the Sadran board, `minutes` after midnight (06:00 = 360, the top of the
 * default 06:00-24:00 grid). Same technique as `board-drafts.spec.ts`.
 */
export async function dragRequestToCar(page: Page, requestId: string, carId: string, minutes: number): Promise<void> {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await column.evaluate((el, minute) => {
    const scroller = el.closest<HTMLElement>(".overflow-auto");
    if (scroller) scroller.scrollTop = Math.max(0, (minute - 360) / 1080 * el.scrollHeight - scroller.clientHeight / 2);
  }, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

/**
 * Pins the member-visible weeks to `keep`. The siddur's "בקשה חדשה" button targets the newest non-live week, and earlier
 * specs leave far-future fixture weeks behind (published, solving), so a spec that clicks the button filters the weeks
 * list the app reads down to the ones it means (the live week and the open week).
 */
export async function keepOnlyWeeks(page: Page, keep: readonly string[]): Promise<void> {
  await page.route("**/rest/v1/weeks?*", async (route) => {
    const response = await route.fetch();
    const body: unknown = await response.json();
    const json = Array.isArray(body) ? body.filter((row: { week_start?: string }) => !!row.week_start && keep.includes(row.week_start)) : body;
    await route.fulfill({ response, json });
  });
}
