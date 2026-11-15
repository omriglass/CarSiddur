import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, SEEDED_USERS, SUPABASE_ANON_KEY, SUPABASE_URL, serviceRoleClient, signIn } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, deleteRequests, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// R20M1 (owner 2026-11-14, REQ item 233): the board strip "מאז שהסתכלת לאחרונה". Two members act on a published day
// (one adds a passenger, one cancels); the Sadran opens the strip (read only then — owner 2026-11-15), both lines are
// new; on the next visit they are listed but no longer new.
test.describe("board strip: since you last looked", { tag: ["@board"] }, () => {
  test("members' published-day actions show quietly on the board", async ({ page }) => {
    const service = serviceRoleClient();
    const week = FIXTURE_WEEKS.liveEvents;
    const day = dayOfWeek(week, 1);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    const requestIds: string[] = [];
    try {
      const carId = await sharedCarIdByName(service, "יונדאי 1");
      const book = async (requester: string, from: string, to: string, until: string) => {
        const requestId = await insertRequest(service, day, { week, requester, depart: from, return: to, destinationId: PLACES.haifa.id, status: "assigned" });
        requestIds.push(requestId);
        const { data, error } = await service.from("rides").insert({
          department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: carId, driver_id: requester, created_by: requester,
          starts_at: winterAt(day, from), ends_at: winterAt(day, to), blocked_until: winterAt(day, until),
          origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
        }).select("id, version").single();
        if (error) throw error;
        const { error: linkError } = await service.from("ride_requests").insert({ ride_id: data.id, request_id: requestId, role: "driver", leg: "both", car_mode: "keep" });
        if (linkError) throw linkError;
        return data.id as string;
      };
      const rideA = await book(PROFILE_IDS.member1, "10:00", "12:00", "12:30");
      const rideB = await book(PROFILE_IDS.member2, "14:00", "16:00", "16:30");
      const asMember = async (user: { email: string; password: string }) => {
        const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
        const { error } = await client.auth.signInWithPassword(user);
        if (error) throw error;
        return client;
      };
      const version = async (rideId: string) => ((await service.from("rides").select("version").eq("id", rideId).single()).data!.version as number);

      const member1 = await asMember(SEEDED_USERS.member1);
      const added = await member1.rpc("add_ride_passengers", { p_ride_id: rideA, p_expected_version: await version(rideA), p_passengers: [{ display_name: "Guest Rider", seat_kind: "adult" }] });
      expect(added.error).toBeNull();
      const member2 = await asMember(SEEDED_USERS.member2);
      const cancelled = await member2.rpc("cancel_ride", { p_ride_id: rideB, p_reason: "member", p_expected_version: await version(rideB) });
      expect(cancelled.error).toBeNull();
      await member1.auth.signOut();
      await member2.auth.signOut();

      await signIn(page, SEEDED_USERS.sadran);
      await page.goto(paths.sadran.board(NEVO_DEPARTMENT_ID, week));
      const strip = page.getByTestId("board-live-events");
      await expect(strip).toBeVisible();
      // closed: nothing is read, no line is shown
      await expect(strip.getByTestId("board-live-event")).toHaveCount(0);
      await strip.getByRole("button", { name: he.liveEvents.title }).click();
      const lines = strip.getByTestId("board-live-event");
      await expect(lines).toHaveCount(2);
      await expect(lines.nth(0)).toContainText(tv("liveEvents.cancelled", { name: SEEDED_USERS.member2.fullName }));
      await expect(lines.nth(1)).toContainText(tv("liveEvents.joined", { names: "Guest Rider", owner: SEEDED_USERS.member1.fullName }));
      await expect(lines.nth(1)).toHaveAttribute("data-new", "true");
      await expect(lines.nth(0)).toHaveAttribute("data-new", "true");
      await lines.nth(1).click();
      await expect(page.getByRole("dialog")).toBeVisible();

      // the next visit: still listed, nothing new
      await page.reload();
      await expect(strip).toBeVisible();
      await strip.getByRole("button", { name: he.liveEvents.title }).click();
      await expect(lines).toHaveCount(2);
      await expect(lines.first()).not.toHaveAttribute("data-new", "true");
    } finally {
      await deleteRequests(service, requestIds);
      await removeWeek(service, week);
    }
  });
});
