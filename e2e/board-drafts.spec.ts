import { expect, test, type Page } from "@playwright/test";
import { he } from "../src/i18n/he";
import { newSignedInPage, NEVO_DEPARTMENT_ID, SEEDED_USERS, serviceRoleClient, scrollGridColumnTo } from "./helpers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Board drafts (REQ §13.94, docs/BOARD_DRAFTS_PLAN_2026-10.md §1): dragging an unmet request
 * beyond its flexibility offers "טיוטה"; the draft is drawn dashed on the board as the result it
 * would produce and the request leaves the unmet list; publishing is refused while it exists,
 * and allowed again once it is discarded. NOT RUN by the author (written, not executed).
 * REQ §13.138: the chooser asks "דיברת עם X על השינוי?" — "כן, כבר סיכמנו" applies at once with no proposal,
 * a draft waits for "שלח את כל ההצעות" in the ⋮ menu (second test).
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
  await scrollGridColumnTo(column, minutes);
  const source = await grip.boundingBox();
  const target = await column.boundingBox();
  if (!source || !target) throw new Error("missing drag source/target");
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + (minutes - 360) / 1080 * target.height, { steps: 12 });
  await expect(page.locator("[data-drag-preview]")).toBeVisible();
  await page.mouse.up();
}

test("a draft is drawn dashed on the board, blocks publishing, and publishing works again once discarded", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  const week = "2042-01-12";
  const member = "00000000-0000-0000-0000-000000000103";
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  await ensureUnpublishedWeek(service, week);
  const at = (time: string) => `${week}T${time}:00+02:00`;
  const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`;
  const contexts: { close: () => Promise<void> }[] = [];
  async function cleanupFixture() {
    await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    const { data: leftovers } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (leftovers?.length) await service.from("ride_requests").delete().in("ride_id", leftovers.map((ride) => ride.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  await cleanupFixture();
  try {
    const { data: request, error } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: member, filed_by: member,
      ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: "00000000-0000-0000-0000-000000000011",
      trip_shape: "round_trip", trip_type: "round_trip", depart_at: at("07:00"), return_at: at("10:00"), status: "submitted",
      flex_depart_early: "00:00:00", flex_depart_late: "00:00:00", flex_return_early: "00:00:00", flex_return_late: "00:00:00",
    }).select("id").single();
    if (error) throw error;

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    // Drag two hours later than requested (flexibility 0) -> chooser -> "טיוטה".
    await dragRequest(page, request.id, cars![0]!.id, 540);
    const chooser = page.getByTestId("draft-choice-dialog");
    await expect(chooser).toBeVisible();
    await page.getByTestId("draft-choice-draft").click();
    await expect(chooser).not.toBeVisible();

    // The draft is a `proposals` row, nothing was sent, and the board shows it as the result.
    const { data: drafts } = await service.from("proposals").select("id,status,type").eq("request_id", request.id);
    expect(drafts).toHaveLength(1);
    expect(drafts![0]).toMatchObject({ status: "draft", type: "shift" });
    const draftBlock = page.locator('button[data-draft="true"]:visible');
    await expect(draftBlock).toHaveCount(1);
    await expect(draftBlock.getByTestId("draft-tag")).toHaveText(he.boardDrafts.tag);
    await expect(page.locator(`[data-request-id="${request.id}"]:visible`)).toHaveCount(0);

    // Publishing is refused and lists the draft.
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/publish`);
    await expect(page.getByTestId("publish-draft-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: he.publicationFlow.allYes, exact: true })).toBeDisabled();

    // Discard it from the board's draft sheet -> the request is unmet again, publishing is allowed.
    await page.goto(boardUrl);
    await page.locator('button[data-draft="true"]:visible').click();
    await page.getByTestId("draft-discard").click();
    await expect(page.locator('button[data-draft="true"]:visible')).toHaveCount(0);
    await expect(page.locator(`[data-request-id="${request.id}"]:visible`).first()).toBeVisible();
    const { data: after } = await service.from("proposals").select("status").eq("request_id", request.id);
    expect(after!.map((row) => row.status)).toEqual(["withdrawn"]);
    await page.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${week}/publish`);
    await expect(page.getByTestId("publish-draft-row")).toHaveCount(0);
    await expect(page.getByRole("button", { name: he.publicationFlow.allYes, exact: true })).toBeEnabled();
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanupFixture();
  }
});

test("\"already agreed\" applies at once with no proposal; drafts go out together with \"send all\"", { tag: ["@board", "@proposals"] }, async ({ browser }) => {
  test.slow();
  const service = serviceRoleClient();
  const week = "2042-01-19";
  const memberA = "00000000-0000-0000-0000-000000000103";
  const memberB = "00000000-0000-0000-0000-000000000104";
  const { data: cars } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1);
  await ensureUnpublishedWeek(service, week);
  const at = (time: string) => `${week}T${time}:00+02:00`;
  const boardUrl = `/sadran/${NEVO_DEPARTMENT_ID}/${week}/board`;
  const contexts: { close: () => Promise<void> }[] = [];
  async function cleanupFixture() {
    await service.from("proposals").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    const { data: leftovers } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (leftovers?.length) await service.from("ride_requests").delete().in("ride_id", leftovers.map((ride) => ride.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
  }
  async function insertRequest(requester: string, depart: string, ret: string) {
    const { data, error } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: requester, filed_by: requester,
      ride_type_id: "00000000-0000-0000-0000-000000000021", destination_id: "00000000-0000-0000-0000-000000000011",
      trip_shape: "round_trip", trip_type: "round_trip", depart_at: at(depart), return_at: at(ret), status: "submitted",
      flex_depart_early: "00:00:00", flex_depart_late: "00:00:00", flex_return_early: "00:00:00", flex_return_late: "00:00:00",
    }).select("id").single();
    if (error) throw error;
    return data.id;
  }
  await cleanupFixture();
  try {
    const requestA = await insertRequest(memberA, "07:00", "10:00");
    const requestB = await insertRequest(memberB, "13:00", "15:00");

    const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
    contexts.push(sadran.context);
    const page = sadran.page;
    await page.setViewportSize({ width: 1600, height: 1100 });
    await page.goto(boardUrl);

    // A: two hours later than requested -> "דיברת עם ...?" -> "כן, כבר סיכמנו": placed now, no proposal reaches anyone.
    await dragRequest(page, requestA, cars![0]!.id, 540);
    const chooser = page.getByTestId("draft-choice-dialog");
    await expect(chooser).toBeVisible();
    await page.getByTestId("draft-choice-agreed").click();
    await expect(chooser).not.toBeVisible();
    await expect.poll(async () => (await service.from("ride_requests").select("ride_id").eq("request_id", requestA)).data?.length ?? 0).toBeGreaterThan(0);
    // The ride moves (the request keeps its own requested times, flexibility stays anchored to them).
    const { data: servedA } = await service.from("ride_requests").select("rides(starts_at,status)").eq("request_id", requestA);
    const rideA = servedA!.map((row) => row.rides as unknown as { starts_at: string; status: string }).find((ride) => ride.status !== "cancelled");
    expect(Date.parse(rideA!.starts_at)).toBe(Date.parse(at("09:00")));
    const { data: proposalNotices } = await service.from("notifications").select("id").eq("week_start", week).in("event", ["proposal_received", "proposal_answered"]);
    expect(proposalNotices).toHaveLength(0);

    // B: same move -> "צריך לדבר — אני עוד עובד/ת על הטיוטה": a draft, the ⋮ counter shows it, nothing is sent.
    await dragRequest(page, requestB, cars![0]!.id, 900);
    await expect(chooser).toBeVisible();
    await page.getByTestId("draft-choice-draft").click();
    await expect(chooser).not.toBeVisible();
    await expect(page.getByTestId("board-pending-count")).toHaveText("1");
    const { data: draftB } = await service.from("proposals").select("id,status").eq("request_id", requestB).single();
    expect(draftB!.status).toBe("draft");

    // "שלח את כל ההצעות": the day is listed and ticked; sending turns the draft into a sent proposal and tells member B.
    await page.getByTestId("board-actions-menu-trigger").click();
    await page.getByTestId("board-send-all").click();
    const dialog = page.getByTestId("send-all-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(`send-all-day-${week}`)).toBeChecked();
    await dialog.getByTestId("send-all-confirm").click();
    await expect.poll(async () => (await service.from("proposals").select("status").eq("id", draftB!.id).single()).data?.status).toBe("sent");
    const { data: received } = await service.from("notifications").select("id").eq("recipient_id", memberB).eq("event", "proposal_received");
    expect(received).toHaveLength(1);
    await dialog.getByRole("button", { name: he.sendAll.done }).click();
    await expect(page.getByTestId("board-pending-count")).toHaveCount(0);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await cleanupFixture();
  }
});
