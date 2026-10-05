import { expect, test, type Page } from "@playwright/test";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Merged ride = one block (REQ §13.94 G10, docs/BOARD_DRAFTS_PLAN_2026-10.md §2). Dragging a
 * one-way request onto a ride opens the merge popup (leg preset "הלוך בלבד", estimated stop
 * time); "טיוטה" draws ONE block on the host's car with the "· מאוחד" marker, never conflict
 * stripes and never two overlapping blocks; dragging the added person's chip out of the block onto
 * the unmet list puts the request back there (draft -> discard, applied -> `unmerge_request`); the
 * sheet button stays as the phone fallback. NOT RUN by the author
 * (written, not executed).
 */
async function ensureUnpublishedWeek(service: SupabaseClient, week: string): Promise<void> {
  const { data: existing } = await service.from("weeks").select("phase").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week).maybeSingle();
  if (!existing) {
    const at = (daysBefore: number) => new Date(Date.parse(`${week}T00:00:00Z`) - daysBefore * 86400000).toISOString();
    const { error } = await service.from("weeks").insert({ department_id: NEVO_DEPARTMENT_ID, week_start: week, phase: "solving", open_at: at(7), close_at: at(3), publish_at: at(2) });
    if (error) throw error;
  } else if (existing.phase !== "solving" && existing.phase !== "open") {
    const { error } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (error) throw error;
  }
}

async function dragRequest(page: Page, requestId: string, carId: string, minutes: number) {
  const grip = page.locator(`[data-request-id="${requestId}"]:visible`).getByRole("button", { name: he.sadranBoard.dragHandleLabel });
  await grip.scrollIntoViewIfNeeded();
  const column = page.locator(`[data-car-col-id="${carId}"]`);
  await column.evaluate((el, minute) => {
    const scroller = el.closest<HTMLElement>(".overflow-auto")!;
    scroller.scrollTop = Math.max(0, (minute - 360) / 1080 * el.scrollHeight - scroller.clientHeight / 2);
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

/** Pointer-drags a merged block's guest chip onto the unmet list (the "guest drag", REQ §13.94 G10). */
async function dragChipToUnmet(page: Page, requestId: string) {
  const chip = page.locator(`button[data-ride-id]:visible [data-guest-chip][data-request-id="${requestId}"]`);
  await chip.scrollIntoViewIfNeeded();
  const zone = page.locator("[data-unmet-drop-zone]:visible").first();
  const source = await chip.boundingBox();
  const target = await zone.boundingBox();
  if (!source || !target) throw new Error("missing guest chip or unmet drop zone");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + 40, { steps: 12 });
  await page.mouse.up();
}

const WEEK = "2042-01-19";
const HOST_MEMBER = "00000000-0000-0000-0000-000000000103";
const GUEST_MEMBER = "00000000-0000-0000-0000-000000000104";
const at = (time: string) => `${WEEK}T${time}:00+02:00`;
const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${WEEK}/board`;

async function cleanup(service: SupabaseClient) {
  await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
  await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
}

async function fixture(service: SupabaseClient, guestStatus: "submitted" | "merged") {
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  const placeId = "00000000-0000-0000-0000-000000000011";
  const base = { department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: placeId };
  const { data: requests, error } = await service.from("requests").insert([
    { ...base, requester_id: HOST_MEMBER, filed_by: HOST_MEMBER, trip_shape: "round_trip", trip_type: "round_trip", depart_at: at("07:15"), return_at: at("10:00"), status: "assigned" },
    { ...base, requester_id: GUEST_MEMBER, filed_by: GUEST_MEMBER, trip_shape: "one_way_to", one_way_car_mode: "passenger", trip_type: "one_way", depart_at: at("07:00"), status: guestStatus },
  ]).select("id");
  if (error) throw error;
  const { data: ride, error: rideError } = await service.from("rides").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: cars![0]!.id, created_by: HOST_MEMBER, driver_id: HOST_MEMBER,
    origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed",
    starts_at: at("07:15"), ends_at: at("10:00"), blocked_until: at("10:30"),
  }).select("id").single();
  if (rideError) throw rideError;
  const links = [{ ride_id: ride.id, request_id: requests![0]!.id, role: "driver", leg: "both", car_mode: "keep" }];
  if (guestStatus === "merged") links.push({ ride_id: ride.id, request_id: requests![1]!.id, role: "passenger", leg: "out", car_mode: "passenger" });
  const { error: linkError } = await service.from("ride_requests").insert(links);
  if (linkError) throw linkError;
  return { carId: cars![0]!.id, hostRequestId: requests![0]!.id, guestRequestId: requests![1]!.id, rideId: ride.id };
}

test("a draft merge is one marked block without conflict stripes, and taking the person out returns the request to unmet", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service, WEEK);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { carId, rideId, guestRequestId } = await fixture(service, "submitted");
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    // Drop the one-way request on the ride: the popup presets "הלוך בלבד" and shows the stop time.
    await dragRequest(page, guestRequestId, carId, 450);
    const dialog = page.getByTestId("merge-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("merge-leg-fixed")).toHaveText(he.mergedRide.legOut);
    await expect(dialog.getByTestId("merge-eta")).toBeVisible();
    await dialog.getByTestId("merge-save-draft").click();
    await expect(dialog).not.toBeVisible();

    // Legs only, never a window; the draft is unsent.
    const { data: drafts } = await service.from("proposals").select("status,type,payload").eq("request_id", guestRequestId);
    expect(drafts).toHaveLength(1);
    expect(drafts![0]).toMatchObject({ status: "draft", type: "merge" });
    // The server stamps the host's own window (no widening) - never a requested window.
    const stamped = drafts![0]!.payload as { starts_at: string; ends_at: string };
    expect(Date.parse(stamped.starts_at)).toBe(Date.parse(at("07:15")));
    expect(Date.parse(stamped.ends_at)).toBe(Date.parse(at("10:00")));

    // ONE block on the host's car: marked "· מאוחד", dashed draft, no red stripes, the host's own block and the guest card gone.
    const merged = page.locator('button[data-merged="true"]:visible');
    await expect(merged).toHaveCount(1);
    await expect(merged.getByTestId("merged-marker")).toHaveText(he.mergedRide.marker);
    await expect(merged).toHaveAttribute("data-draft", "true");
    await expect(merged).not.toHaveClass(/border-destructive/);
    await expect(page.locator(`button[data-ride-id="${rideId}"]:visible`)).toHaveCount(0);
    // the unmet card is gone (the guest chip inside the merged block carries the same data-request-id)
    await expect(page.locator(`[data-request-id="${guestRequestId}"]:visible:not([data-guest-chip])`)).toHaveCount(0);
    await expect(page.locator("button[data-ride-id]:visible.border-destructive")).toHaveCount(0);

    // Drag the added person's chip out of the block onto the unmet list: the draft is discarded,
    // the request is back in the list and the host ride is a plain block again.
    await expect(merged.getByTestId("guest-chips")).toBeVisible();
    await dragChipToUnmet(page, guestRequestId);
    await expect(page.locator('button[data-merged="true"]:visible')).toHaveCount(0);
    await expect.poll(async () => ((await service.from("proposals").select("status").eq("request_id", guestRequestId)).data ?? []).map((row) => row.status)).toEqual(["withdrawn"]);
    await expect(page.locator(`[data-request-id="${guestRequestId}"]:visible`).first()).toBeVisible();
    await expect(page.locator(`button[data-ride-id="${rideId}"]:visible`)).toHaveCount(1);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});

test("an applied merge: the added person leaves by dragging the chip to the unmet list", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service, WEEK);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { rideId, guestRequestId } = await fixture(service, "merged");
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    const block = page.locator(`button[data-ride-id="${rideId}"]:visible`);
    await expect(block).toHaveCount(1);
    // Drag the guest chip out of the applied block onto the unmet list (`unmerge_request`) ...
    await dragChipToUnmet(page, guestRequestId);
    await expect(page.locator(`[data-request-id="${guestRequestId}"]:visible`).first()).toBeVisible();
    await expect.poll(async () => (await service.from("requests").select("status").eq("id", guestRequestId).single()).data?.status).toBe("submitted");
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});

test("the sheet button \"הוצא מהנסיעה\" remains the fallback (phone list mode)", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  await ensureUnpublishedWeek(service, WEEK);
  await cleanup(service);
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const { rideId, guestRequestId } = await fixture(service, "merged");
    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);
    const block = page.locator(`button[data-ride-id="${rideId}"]:visible`);
    await block.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByTestId("ride-added-person")).toHaveCount(1);
    await sheet.getByTestId("ride-added-person").getByRole("button").click();
    await expect(sheet).not.toBeVisible();

    // `unmerge_request`: the guest's request is submitted again and listed as unmet.
    await expect(page.locator(`[data-request-id="${guestRequestId}"]:visible`).first()).toBeVisible();
    const { data: request } = await service.from("requests").select("status").eq("id", guestRequestId).single();
    expect(request!.status).toBe("submitted");
    const { data: links } = await service.from("ride_requests").select("request_id").eq("ride_id", rideId);
    expect(links!.map((link) => link.request_id)).not.toContain(guestRequestId);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanup(service);
  }
});
