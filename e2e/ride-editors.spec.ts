import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, openRideDetails, SEEDED_USERS, serviceRoleClient } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// REQ §13.202: member1 names member2 in Profile → פרטים אישיים ("מי יכול/ה לערוך את הנסיעות שלי"); member2 gets one inbox
// message (no push), sees member1's request on "my rides" only with the eye-menu option on, and removes it — member1 is told.
const WEEK = "2041-01-27";

test.use({ viewport: { width: 390, height: 844 }, actionTimeout: 15_000 });

test("a named editor sees and removes the owner's request; the owner is told (REQ §13.202)", { tag: ["@my-week", "@notifications"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const reset = async () => {
    await service.from("ride_editors").delete().eq("owner_id", PROFILE_IDS.member1);
    await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_editor_added");
    await removeWeek(service, WEEK);
  };
  await reset();
  const { error: weekError } = await service.from("weeks").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, phase: "open",
    open_at: "2000-01-01T00:00:00Z", close_at: "2090-01-01T00:00:00Z", publish_at: "2090-01-02T00:00:00Z",
  });
  if (weekError) throw weekError;
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const requestId = await insertRequest(service, dayOfWeek(WEEK, 2), { week: WEEK, requester: PROFILE_IDS.member1, depart: "09:00", return: "13:00", destinationId: PLACES.haifa.id });

    await test.step("member1 names member2", async () => {
      const owner = await newSignedInPage(browser, SEEDED_USERS.member1);
      contexts.push(owner.context);
      await owner.page.goto("/profile");
      const card = owner.page.getByTestId("profile-ride-editors");
      await expect(card).toContainText(he.profileExtra.rideEditorsTitle);
      await card.getByRole("combobox", { name: he.profileExtra.rideEditorsPicker }).click();
      await owner.page.getByRole("option", { name: SEEDED_USERS.member2.fullName }).click();
      await owner.page.keyboard.press("Escape");
      await card.getByTestId("ride-editors-save").click();
      await expect(owner.page.getByText(he.profileExtra.rideEditorsSaved)).toBeVisible();
      await expect(card.getByTestId("ride-editors-save")).toHaveCount(0);
    });
    const { data: message } = await service.from("notifications").select("id, title_he").eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_editor_added").single();
    expect(message!.title_he).toContain(SEEDED_USERS.member1.fullName);
    const { count: pushes } = await service.from("push_outbox").select("id", { count: "exact", head: true }).eq("notification_id", message!.id);
    expect(pushes).toBe(0);

    await test.step("member2: hidden until the eye option, then removes it", async () => {
      const editor = await newSignedInPage(browser, SEEDED_USERS.member2);
      contexts.push(editor.context);
      const page = editor.page;
      await page.goto(paths.my());
      const ownerLine = page.getByTestId("request-editor-line");
      await expect(page.getByTestId("my-display-menu-trigger")).toBeVisible({ timeout: 15_000 });
      await expect(ownerLine).toHaveCount(0);
      await page.getByTestId("my-display-menu-trigger").click();
      await page.getByTestId("my-show-editor-rides").click();
      await expect(page.getByTestId("my-show-editor-rides")).toHaveAttribute("aria-checked", "true");
      await page.keyboard.press("Escape");
      const row = page.locator(`[data-request-id="${requestId}"]`).first();
      await expect(row.getByTestId("request-editor-line")).toHaveText(tv("request.editorOf", { name: SEEDED_USERS.member1.fullName }));
      await row.getByRole("button", { name: he.requestsList.cancel }).click();
      await page.getByRole("dialog").getByRole("button", { name: he.requestsList.withdraw }).click();
      await expect.poll(async () => (await service.from("requests").select("status").eq("id", requestId).single()).data?.status).toBe("withdrawn");
    });
    const { data: told } = await service.from("notifications").select("data, title_he").eq("recipient_id", PROFILE_IDS.member1).eq("event", "ride_edited");
    expect(told!.some((n) => (n.data as { variant?: string }).variant === "editor_withdrew" && n.title_he.includes(SEEDED_USERS.member2.fullName))).toBe(true);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member1).eq("event", "ride_edited").contains("data", { variant: "editor_withdrew" });
    await reset();
  }
});

// The same on the siddur: the owner's published ride offers the editor "עריכת הבקשה של X" and "בטל נסיעה" (as the owner's).
const PUBLISHED_WEEK = "2041-02-03";

test("on the siddur the editor edits and removes the owner's ride (REQ §13.202)", { tag: ["@siddur", "@notifications"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const reset = async () => {
    await service.from("ride_editors").delete().eq("owner_id", PROFILE_IDS.member1);
    await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member2).eq("event", "ride_editor_added");
    await removeWeek(service, PUBLISHED_WEEK, { keepWeek: true });
  };
  await reset();
  const admin = await publishedFixtureWeek(PUBLISHED_WEEK);
  await admin.auth.signOut();
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    const day = dayOfWeek(PUBLISHED_WEEK, 2);
    const requestId = await insertRequest(service, day, { week: PUBLISHED_WEEK, requester: PROFILE_IDS.member1, depart: "09:00", return: "13:00", destinationId: PLACES.haifa.id, status: "assigned" });
    const { data: ride, error } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: PUBLISHED_WEEK, car_id: await sharedCarIdByName(service, "יונדאי 1"),
      driver_id: PROFILE_IDS.member1, created_by: PROFILE_IDS.member1,
      starts_at: winterAt(day, "09:00"), ends_at: winterAt(day, "13:00"), blocked_until: winterAt(day, "13:30"),
      origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
    }).select("id").single();
    if (error) throw error;
    await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
    await service.from("ride_editors").insert({ department_id: NEVO_DEPARTMENT_ID, owner_id: PROFILE_IDS.member1, editor_id: PROFILE_IDS.member2 });

    const editor = await newSignedInPage(browser, SEEDED_USERS.member2);
    contexts.push(editor.context);
    const page = editor.page;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${PUBLISHED_WEEK}?day=${day}`);
    await openRideDetails(page, page.locator(`[data-ride-id="${ride!.id}"]:visible`).first());
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("link", { name: tv("rideDetail.editRequestOf", { name: SEEDED_USERS.member1.fullName }) })).toHaveAttribute("href", new RegExp(`/requests/${requestId}/edit`));
    await dialog.getByRole("button", { name: he.action.cancelRide }).click();
    await page.getByRole("alertdialog").or(page.getByRole("dialog").filter({ hasText: he.request.cancelConfirmTitle })).last()
      .getByRole("button", { name: he.action.cancelRide }).click();
    await expect.poll(async () => (await service.from("rides").select("status").eq("id", ride!.id).single()).data?.status).toBe("cancelled");
    const { data: told } = await service.from("notifications").select("data").eq("recipient_id", PROFILE_IDS.member1).eq("event", "ride_edited");
    expect(told!.some((n) => (n.data as { variant?: string }).variant === "editor_cancelled")).toBe(true);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await service.from("notifications").delete().eq("recipient_id", PROFILE_IDS.member1).eq("event", "ride_edited").contains("data", { variant: "editor_cancelled" });
    await reset();
  }
});
