import { expect, test, type Locator } from "@playwright/test";
import { publishedFixtureWeek } from "./published-week";
import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, openRideDetails } from "./helpers";

test.use({ actionTimeout: 15_000 });

test("members resize owned rides and resolve a shadow collision through explicit driver consent", { tag: ["@siddur", "@board"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const week = "2041-01-06";
  const members = ["00000000-0000-0000-0000-000000000103", "00000000-0000-0000-0000-000000000104"];
  const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
  const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").eq("status", "active").limit(1).single();
  const admin = await publishedFixtureWeek(week);
  await admin.auth.signOut();
  const rideIds: string[] = [];
  const contexts: { close: () => Promise<void> }[] = [];
  try {
    for (const [index, member] of members.entries()) {
      const start = index ? "12" : "10";
      const end = index ? "14" : "11";
      const { data: request, error: requestError } = await service.from("requests").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, requester_id: member, filed_by: member,
        ride_type_id: "00000000-0000-0000-0000-000000000021", destination_text: `E2E shadow ${index}`,
        trip_shape: "round_trip", depart_at: `${week}T${start}:00:00+02:00`, return_at: `${week}T${end}:00:00+02:00`, status: "assigned",
      }).select("id").single();
      if (requestError) throw requestError;
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: car!.id, driver_id: member, created_by: member,
        starts_at: `${week}T${start}:00:00+02:00`, ends_at: `${week}T${end}:00:00+02:00`, blocked_until: `${week}T${end}:30:00+02:00`,
        origin_id: department!.home_destination_id, destination_id: department!.home_destination_id, status: "confirmed",
      }).select("id").single();
      if (rideError) throw rideError;
      rideIds.push(ride!.id);
      const { error: linkError } = await service.from("ride_requests").insert({ ride_id: ride!.id, request_id: request!.id, role: "driver", leg: "both", car_mode: "keep" });
      if (linkError) throw linkError;
    }
    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    contexts.push(member1.context);
    const page = member1.page;
    /** Drags from the middle of `handle` downwards until the drag preview reads `preview`, then drops. */
    async function dragUntil(handle: Locator, preview: string) {
      await handle.scrollIntoViewIfNeeded();
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2;
      let y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 0; step < 400; step += 1) {
        y += 2;
        await page.mouse.move(x, y);
        if (((await page.locator("[data-drag-preview]").textContent().catch(() => "")) ?? "").includes(preview)) break;
      }
      await expect(page.locator("[data-drag-preview]")).toContainText(preview);
      await page.mouse.up();
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/siddur/${NEVO_DEPARTMENT_ID}/${week}`);
    const own = page.locator(`[data-ride-id="${rideIds[0]}"]:visible`);
    const other = page.locator(`[data-ride-id="${rideIds[1]}"]:visible`);
    await openRideDetails(page, other);
    await expect(page.getByText(he.rideEditing.edit, { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    // REQ §13.171: my own ride's sheet is a summary (its edit is the form) — hours change on the grid, in edit mode.
    await openRideDetails(page, own);
    await expect(page.getByTestId("ride-edit-request")).toBeVisible();
    await expect(page.getByRole("dialog").getByLabel(he.field.return, { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByTestId("edit-mode-button").locator("visible=true").click();
    await dragUntil(own.locator(".bottom-0"), "10:00–11:30");
    await expect.poll(async () => new Date((await service.from("rides").select("ends_at").eq("id", rideIds[0]).single()).data!.ends_at).toISOString())
      .toBe("2041-01-06T09:30:00.000Z");

    await dragUntil(own, "12:00–13:30");
    await expect(page.getByRole("heading", { name: he.rideEditing.collisionTitle })).toBeVisible();
    await page.getByRole("button", { name: he.rideEditing.acknowledge }).click();
    await expect(page.locator('[data-ride-id^="change:"]')).toBeVisible();
    await expect(other).toHaveClass(/opacity-50/);
    const { data: before } = await service.from("rides").select("id,status,starts_at").in("id", rideIds);
    expect(before!.every((r) => r.status === "confirmed")).toBe(true);
    expect(new Date(before!.find((r) => r.id === rideIds[0])!.starts_at).toISOString()).toBe("2041-01-06T08:00:00.000Z");
    const { data: notifications } = await service.from("notifications").select("title_he,body_he").eq("recipient_id", members[1]).eq("week_start", week);
    expect(notifications!.length).toBeGreaterThan(0);
    expect(JSON.stringify(notifications)).not.toContain("{{");

    const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
    contexts.push(member2.context);
    await member2.page.goto("/inbox");
    await member2.page.getByRole("button", { name: he.rideEditing.accept }).click();
    await expect(member2.page.getByRole("button", { name: he.rideEditing.accept })).toHaveCount(0);
    const { data: after } = await service.from("rides").select("id,status,starts_at").in("id", rideIds);
    expect(after!.find((r) => r.id === rideIds[1])!.status).toBe("cancelled");
    expect(new Date(after!.find((r) => r.id === rideIds[0])!.starts_at).toISOString()).toBe("2041-01-06T10:00:00.000Z");
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await service.from("ride_change_requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    if (rideIds.length) await service.from("ride_requests").delete().in("ride_id", rideIds);
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", week);
    // Keep the immutable empty publication; the next disposable-stack reset removes it.
  }
});
