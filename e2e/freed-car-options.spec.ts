import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { paths } from "../src/app/routes";
import { he } from "../src/i18n/he";
import {
  NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, SUPABASE_ANON_KEY, SUPABASE_URL, waitForCondition,
  wireEdgeFunctionSettings,
} from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { dayOfWeek, FIXTURE_WEEKS, insertRequest, PLACES, PROFILE_IDS, removeWeek, sharedCarIdByName, winterAt } from "./request-form";

// REQ §13.168: a freed car that a plan B and two waiting-list requests compete for is not obvious, so the
// on-ride-cancelled edge function leaves it to the Sadran with ranked options. A waiting candidate steps out from /my
// ("לוותר הפעם"); the Sadran gives the car to the plan-B member, who leaves the plan B for the main trip.
// Same fixture as scripts/qa/freed-car-scenario.sql: A 07:00–20:00 on car 1 is cancelled; W1 (admin) 10:00–12:00 and
// W2 (member2) 19:00–22:00 wait; P (member1) 07:00–17:00 rides its plan B (a הקפצה to Binyamina) on car 2.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("freed car vs plan B", { tag: ["@waitlist", "@solver"] }, () => {
  test("the Sadran decides from the ranked options; a candidate steps out", async ({ browser }) => {
    test.setTimeout(120_000);
    const service = serviceRoleClient();
    // A stack whose edge function is already wired (cron secret stored) keeps its settings.
    const { data: secret } = await service.from("app_secrets").select("key").eq("key", "cron_secret").maybeSingle();
    const wired = !!secret || (await wireEdgeFunctionSettings()).cronSecretWired;
    test.skip(!wired, "no CRON_SECRET wired — cancel_ride()'s pg_net call to on-ride-cancelled cannot authenticate");

    const week = FIXTURE_WEEKS.freedCar;
    const day = dayOfWeek(week, 2);
    await removeWeek(service, week);
    const admin = await publishedFixtureWeek(week);
    await admin.auth.signOut();
    const requestIds: string[] = [];
    try {
      const car1 = await sharedCarIdByName(service, "יונדאי 1");
      const car2 = await sharedCarIdByName(service, "יונדאי 2");
      const a = await insertRequest(service, day, { week, requester: PROFILE_IDS.sadran, depart: "07:00", return: "20:00", destinationId: PLACES.haifa.id, status: "assigned" });
      const w1 = await insertRequest(service, day, { week, requester: PROFILE_IDS.admin, depart: "10:00", return: "12:00", destinationId: PLACES.haifa.id,
        status: "waitlisted", extra: { status_reason: "WAITLISTED_NO_CAR" } });
      const w2 = await insertRequest(service, day, { week, requester: PROFILE_IDS.member2, depart: "19:00", return: "22:00", destinationId: PLACES.haifa.id,
        status: "waitlisted", extra: { status_reason: "WAITLISTED_NO_CAR" } });
      const p = await insertRequest(service, day, { week, requester: PROFILE_IDS.member1, depart: "07:00", return: "17:00", destinationId: PLACES.haifa.id,
        extra: { fallback: "alternative" } });
      requestIds.push(a, w1, w2, p);
      {
        const { error } = await service.from("request_alternatives").insert({ request_id: p, department_id: NEVO_DEPARTMENT_ID, week_start: week,
          drop_place_id: PLACES.binyamina.id, arrive_by: winterAt(day, "08:00"), pickup: true, pickup_at: winterAt(day, "17:00") });
        if (error) throw error;
      }
      const { data: ride, error: rideError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: week, car_id: car1, driver_id: PROFILE_IDS.sadran, created_by: PROFILE_IDS.sadran,
        starts_at: winterAt(day, "07:00"), ends_at: winterAt(day, "20:00"), blocked_until: winterAt(day, "20:30"),
        origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
      }).select("id, version").single();
      if (rideError) throw rideError;
      await service.from("ride_requests").insert({ ride_id: ride.id, request_id: a, role: "driver", leg: "both", car_mode: "keep" });
      // P is served by its plan B, as when the Sadran sends the plan-B proposal and it is accepted
      for (const [fn, args] of [
        ["_convert_to_alternative", { p_request_id: p, p_dep: winterAt(day, "07:15"), p_ret: winterAt(day, "17:30") }],
        ["place_request_on_car", { p_request_id: p, p_car_id: car2, p_manual: true, p_actor: PROFILE_IDS.sadran, p_named_driver: null, p_dep: null, p_ret: null, p_reason: "MANUAL" }],
      ] as const) {
        const { error } = await service.rpc(fn, args);
        if (error) throw error;
      }
      expect((await service.from("requests").select("served_by_alternative").eq("id", p).single()).data?.served_by_alternative).toBe(true);

      // the Sadran cancels A's ride: the edge function ranks the candidates and leaves the choice to the Sadran
      const sadranApi = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
      await sadranApi.auth.signInWithPassword(SEEDED_USERS.sadran);
      {
        const { error } = await sadranApi.rpc("cancel_ride", { p_ride_id: ride.id, p_reason: "E2E freed car", p_expected_version: ride.version });
        if (error) throw error;
      }
      let offerId = "";
      await waitForCondition(async () => {
        const { data } = await service.from("freed_slot_offers").select("id, status, options").eq("cancelled_ride_id", ride.id).maybeSingle();
        offerId = (data?.id as string | undefined) ?? "";
        return data?.status === "pending_approval" && Array.isArray(data.options) && data.options.length > 0;
      }, { timeoutMs: 45_000, message: "the freed car never reached the Sadran with options" });

      await test.step("a waiting candidate sees the Sadran is deciding and steps out", async () => {
        const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
        await member2.page.goto(paths.my());
        await expect(member2.page.getByText(he.freedSlot.sadranDeciding)).toBeVisible();
        await member2.page.getByTestId("freed-step-out").click();
        const stepOut = member2.page.getByRole("alertdialog").or(member2.page.getByRole("dialog")).filter({ hasText: he.freedSlot.withdrawClaimTitle });
        await stepOut.getByRole("button", { name: he.freedSlot.stepOut, exact: true }).click();
        await expect.poll(async () => (await service.from("freed_slot_claims").select("status").eq("offer_id", offerId).eq("request_id", w2).maybeSingle()).data?.status)
          .toBe("withdrawn");
        await member2.context.close();
      });

      await test.step("the Sadran sees the ranked options and gives the car to the plan-B member", async () => {
        const sadran = await newSignedInPage(browser, SEEDED_USERS.sadran);
        await sadran.page.goto(paths.sadran.claims(NEVO_DEPARTMENT_ID, week, offerId));
        const options = sadran.page.getByTestId(`freed-offer-options-${offerId}`);
        await expect(options).toBeVisible();
        await expect(options.getByText(he.sadranClaims.recommended)).toHaveCount(1);
        // every option with the member who stepped out is blocked
        const withW2 = options.getByTestId("freed-option").filter({ hasText: SEEDED_USERS.member2.fullName });
        for (const row of await withW2.all()) await expect(row.getByTestId("freed-option-give")).toBeDisabled();
        const more = options.getByRole("button", { name: he.sadranClaims.moreOptionOne });
        if (await more.isVisible()) await more.click();
        const planBOption = options.getByTestId("freed-option")
          .filter({ hasText: SEEDED_USERS.member1.fullName })
          .filter({ hasNotText: SEEDED_USERS.admin.fullName })
          .filter({ hasNotText: SEEDED_USERS.member2.fullName });
        await planBOption.getByTestId("freed-option-give").click();
        const confirm = sadran.page.getByRole("alertdialog").or(sadran.page.getByRole("dialog"));
        await expect(confirm).toContainText(SEEDED_USERS.member1.fullName);
        await confirm.getByRole("button", { name: he.common.confirm, exact: true }).click();

        await expect.poll(async () => (await service.from("requests").select("status, served_by_alternative").eq("id", p).single()).data)
          .toEqual({ status: "assigned", served_by_alternative: false });
        const { data: links } = await service.from("ride_requests").select("rides!inner(car_id, status)").eq("request_id", p);
        expect((links ?? []).map((link) => (link.rides as unknown as { car_id: string; status: string }).car_id)).toContain(car1);
        await expect.poll(async () => (await service.from("freed_slot_offers").select("status").eq("id", offerId).single()).data?.status)
          .not.toBe("pending_approval");
        await sadran.context.close();
      });
    } finally {
      if (requestIds.length) await service.from("notifications").delete().in("data->>request_id", requestIds);
      await removeWeek(service, week);
    }
  });
});
