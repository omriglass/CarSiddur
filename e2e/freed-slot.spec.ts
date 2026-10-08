import { expect, test } from "@playwright/test";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { TZ } from "../src/lib/time";

import {
  NEVO_DEPARTMENT_ID,
  newSignedInPage,
  SEEDED_USERS,
  serviceRoleClient,
  waitForCondition,
  wireEdgeFunctionSettings,
} from "./helpers";

// REQUIREMENTS §8 "Member cancels a ride" → freed-slot offer. Cancelling the seeded Live
// week's ride ...301 (car "יונדאי 1", member1's request ...201) opens a freed_slot_offers
// row; `cancel_ride()` fires the `on-ride-cancelled` edge function via pg_net (async), which
// ranks candidates and calls `resolve_freed_offer()`. The seed (supabase/seed.sql,
// DATA_MODEL.md §6.1 item 19) has exactly one overlapping `waitlisted` request that fits —
// member2's request ...204 — so this exercises the single-candidate "auto-assigned, no claim
// needed" branch (REQUIREMENTS §8's own wording: "if there is exactly one candidate, it is
// auto-assigned and notified").
const CANCELLED_RIDE_ID = "00000000-0000-0000-0000-000000000301";
const CANDIDATE_REQUEST_ID = "00000000-0000-0000-0000-000000000204";
/** The seeded request served by ride ...301 (`supabase/seed.sql`). */
const FIXTURE_REQUEST_ID = "00000000-0000-0000-0000-000000000201";

test.describe("freed slot (live week, single candidate)", { tag: ["@waitlist", "@solver"] }, () => {
  // The test shifts the seeded fixture to today/tomorrow and lets the offer auto-assign member2's request. That leaves
  // member2 with a booking on a day other specs use (quick-request.spec.ts files on Friday), so everything it changes is
  // put back afterwards.
  let restore: (() => Promise<void>) | null = null;
  test.afterEach(async () => {
    await restore?.();
    restore = null;
  });

  test("member1 cancels an assigned ride and member2's overlapping waitlisted request is auto-assigned", async ({
    browser,
  }) => {
    // The two waitForCondition polls below (offer creation, then resolution via the async
    // pg_net round trip to the edge function) can legitimately take longer than Playwright's
    // default 30s per-test budget together with the sign-ins and UI steps around them.
    test.setTimeout(90_000);

    const { cronSecretWired } = await wireEdgeFunctionSettings();
    test.skip(
      !cronSecretWired,
      "supabase/functions/.env has no CRON_SECRET on this machine — cancel_ride()'s pg_net call " +
        "to on-ride-cancelled can't authenticate, so the freed-slot round trip can't be exercised locally.",
    );

    const client = serviceRoleClient();
    const original = {
      requests: (await client.from("requests").select("id, depart_at, return_at, status, status_reason").in("id", [FIXTURE_REQUEST_ID, CANDIDATE_REQUEST_ID])).data ?? [],
      links: (await client.from("ride_requests").select("*").eq("ride_id", CANCELLED_RIDE_ID)).data ?? [],
      ride: (await client.from("rides").select("starts_at, ends_at, blocked_until, car_id, status").eq("id", CANCELLED_RIDE_ID).single()).data,
    };
    restore = async () => {
      const { data: offers } = await client.from("freed_slot_offers").select("id").eq("cancelled_ride_id", CANCELLED_RIDE_ID);
      const offerIds = (offers ?? []).map((offer) => offer.id as string);
      if (offerIds.length) await client.from("freed_slot_claims").delete().in("offer_id", offerIds);
      // The freed car was handed to the candidate: undo that link before moving anything back.
      // The link between ride and request rejects a day mismatch, so unlink while both move back.
      const { data: candidateLinks } = await client.from("ride_requests").select("ride_id").eq("request_id", CANDIDATE_REQUEST_ID);
      await client.from("ride_requests").delete().eq("request_id", CANDIDATE_REQUEST_ID);
      await client.from("ride_requests").delete().eq("ride_id", CANCELLED_RIDE_ID);
      // The auto-assignment created its own ride for the candidate on the freed car: remove it.
      const created = [...new Set((candidateLinks ?? []).map((link) => link.ride_id as string))].filter((id) => id !== CANCELLED_RIDE_ID);
      if (created.length) {
        await client.from("ride_requests").delete().in("ride_id", created);
        await client.from("rides").delete().in("id", created);
      }
      await client.from("freed_slot_offers").delete().eq("cancelled_ride_id", CANCELLED_RIDE_ID);
      if (original.ride) {
        const { error } = await client.from("rides").update({
          starts_at: original.ride.starts_at, ends_at: original.ride.ends_at, blocked_until: original.ride.blocked_until, car_id: original.ride.car_id,
          status: original.ride.status, cancelled_at: null, cancelled_by: null, cancel_reason: null,
        }).eq("id", CANCELLED_RIDE_ID);
        if (error) throw error;
      }
      for (const row of original.requests) {
        await client.from("requests").update({ depart_at: row.depart_at, return_at: row.return_at, status: row.status, status_reason: row.status_reason }).eq("id", row.id);
      }
      if (original.links.length) {
        const { error } = await client.from("ride_requests").insert(original.links.map(({ covers_out: _out, covers_return: _return, ...link }) => link));
        if (error) throw error;
      }
      await client.from("notifications").delete().contains("data", { request_id: CANDIDATE_REQUEST_ID });
    };

    // `/my` shows requests from today onward only (REQ §13.91). The seeded fixture — ride
    // ...301 with request ...201 and member2's overlapping waitlisted request ...204 — sits on
    // Tuesday of the live week, so from Wednesday on it would be hidden. Shift the three rows
    // to today (or tomorrow once today's window is nearly over), keeping their 08:00–16:00
    // Jerusalem window; skip when that would leave the live week.
    const now = new Date();
    const jerusalemHour = Number(formatInTimeZone(now, TZ, "H"));
    const targetDay = new Date(now.getTime() + (jerusalemHour >= 15 ? 24 : 0) * 3600_000);
    const targetKey = formatInTimeZone(targetDay, TZ, "yyyy-MM-dd");
    const { data: fixtureRide } = await client.from("rides").select("starts_at, week_start").eq("id", CANCELLED_RIDE_ID).single();
    const seededKey = formatInTimeZone(fixtureRide!.starts_at, TZ, "yyyy-MM-dd");
    const weekEnd = new Date(Date.parse(`${fixtureRide!.week_start}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    test.skip(targetKey > weekEnd, "the freed-slot fixture cannot be moved to a day inside the live week today");
    if (seededKey !== targetKey) {
      const shiftMs = Date.parse(`${targetKey}T00:00:00Z`) - Date.parse(`${seededKey}T00:00:00Z`);
      const shift = (iso: string) => new Date(Date.parse(iso) + shiftMs).toISOString();
      const { data: rows } = await client.from("requests").select("id, depart_at, return_at").in("id", [FIXTURE_REQUEST_ID, CANDIDATE_REQUEST_ID]);
      for (const row of rows ?? []) {
        const { error } = await client.from("requests").update({ depart_at: shift(row.depart_at!), return_at: shift(row.return_at!) }).eq("id", row.id);
        if (error) throw error;
      }
      const { data: ride } = await client.from("rides").select("starts_at, ends_at, car_id, department_id").eq("id", CANCELLED_RIDE_ID).single();
      // Earlier specs may have put another ride on this car on the target day (car-swap.spec.ts swaps
      // today's cars), which the turnaround guard refuses; move the fixture to a shared car with no
      // other ride that day, preferring its own.
      const dayStart = fromZonedTime(`${targetKey}T00:00:00`, TZ).toISOString();
      const dayEnd = fromZonedTime(`${targetKey}T23:59:59`, TZ).toISOString();
      const { data: busyRides } = await client.from("rides").select("car_id").neq("status", "cancelled").neq("id", CANCELLED_RIDE_ID)
        .gte("starts_at", new Date(Date.parse(dayStart) - 6 * 3600_000).toISOString()).lt("starts_at", dayEnd);
      const busyCars = new Set((busyRides ?? []).map((r) => r.car_id));
      const { data: cars } = await client.from("cars").select("id").eq("department_id", ride!.department_id).eq("type", "shared").eq("status", "active").order("id");
      const carId = !busyCars.has(ride!.car_id) ? ride!.car_id : (cars ?? []).find((c) => !busyCars.has(c.id))?.id;
      test.skip(!carId, "no shared car is free on the target day for the freed-slot fixture");
      const { error } = await client.from("rides").update({ starts_at: shift(ride!.starts_at), ends_at: shift(ride!.ends_at), car_id: carId! }).eq("id", CANCELLED_RIDE_ID);
      if (error) throw error;
    }

    // Two separate browser contexts (Stage 3 hardening fix, e2e/helpers.ts `newSignedInPage`):
    // reusing one `page` across two identities is unreliable, since `/login` redirects an
    // already-authenticated session straight back to wherever it came from rather than
    // showing the sign-in form again.
    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    // `/requests` now redirects to `/my` (2026-09-16, REQ §13 item 91); the cancelled ride is
    // on the seeded Live week, which `/my`'s week-list section shows under the default `auto`
    // home-week preference (a ride today/tomorrow picks the live week).
    await member1.page.goto("/my");

    await member1.page.getByRole("button", { name: "בטל נסיעה" }).first().click();
    await expect(member1.page.getByRole("heading", { name: "לבטל את הנסיעה?" })).toBeVisible();
    await member1.page.getByRole("dialog").getByRole("button", { name: "בטל נסיעה" }).click();

    // `runConfirmAction()` (`HomePage.tsx`, moved from the deleted `RequestsListPage.tsx`) closes
    // the dialog synchronously and fires the
    // `cancel_ride` mutation in the background (fire-and-forget from the component's own
    // perspective) — the dialog closing is not proof the RPC call has actually reached the
    // server yet, so wait for the real DB effect before tearing down this context (closing it
    // too early would abort the in-flight request).
    await waitForCondition(
      async () => {
        const { data } = await client.from("rides").select("status").eq("id", CANCELLED_RIDE_ID).single();
        return data?.status === "cancelled";
      },
      { message: "cancel_ride() never persisted — ride never reached status = cancelled" },
    );
    await member1.context.close();

    // The offer is created synchronously inside cancel_ride(); the resolution (ranking +
    // resolve_freed_offer) happens asynchronously via pg_net once the edge function responds.
    await waitForCondition(
      async () => {
        const { data } = await client
          .from("freed_slot_offers")
          .select("id, status")
          .eq("cancelled_ride_id", CANCELLED_RIDE_ID)
          .maybeSingle();
        return !!data;
      },
      { message: "freed_slot_offers row for the cancelled ride never appeared" },
    );

    const { data: offerRow } = await client
      .from("freed_slot_offers")
      .select("id, status, department_id")
      .eq("cancelled_ride_id", CANCELLED_RIDE_ID)
      .single();
    expect(offerRow?.department_id).toBe(NEVO_DEPARTMENT_ID);

    await waitForCondition(
      async () => {
        const { data } = await client.from("freed_slot_offers").select("status").eq("id", offerRow!.id).single();
        return data?.status === "auto_assigned";
      },
      {
        timeoutMs: 20_000,
        message: "freed_slot_offers never resolved to auto_assigned — check the edge runtime / pg_net wiring",
      },
    );

    // member2 gets the freed_slot_auto inbox notification (seeded copy verbatim) — a fresh
    // context (see the `member1` note above).
    const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
    try {
      await member2.page.goto("/inbox");
      await expect(member2.page.getByText("שובצת לרכב שהתפנה")).toBeVisible({ timeout: 10_000 });
    } finally {
      await member2.context.close();
    }

    // ...and request ...204 is now assigned (the authoritative check; both of member2's
    // requests happen to have the same "חיפה" destination text, so asserting via a UI card
    // filtered only by that text would be ambiguous — this is unambiguous).
    const { data: requestRow } = await client
      .from("requests")
      .select("status, status_reason")
      .eq("id", CANDIDATE_REQUEST_ID)
      .single();
    expect(requestRow?.status).toBe("assigned");
    expect(requestRow?.status_reason).toBe("FREED_SLOT_AUTO");
  });
});
