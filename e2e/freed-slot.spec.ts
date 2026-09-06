import { expect, test } from "@playwright/test";

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

test.describe("freed slot (live week, single candidate)", () => {
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

    // Two separate browser contexts (Stage 3 hardening fix, e2e/helpers.ts `newSignedInPage`):
    // reusing one `page` across two identities is unreliable, since `/login` redirects an
    // already-authenticated session straight back to wherever it came from rather than
    // showing the sign-in form again.
    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    await member1.page.goto("/requests");

    await member1.page.getByRole("button", { name: "בטל נסיעה" }).first().click();
    await expect(member1.page.getByRole("heading", { name: "לבטל את הנסיעה?" })).toBeVisible();
    await member1.page.getByRole("dialog").getByRole("button", { name: "בטל נסיעה" }).click();

    // `runConfirm()` (RequestsListPage.tsx) closes the dialog synchronously and fires the
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
