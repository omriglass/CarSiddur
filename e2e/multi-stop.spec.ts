import { expect, test } from "@playwright/test";

import { he, t, tv } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

// Multi-stop rides (REQ §13.93 "Multi-stop rides", docs/ORIGINS_PLAN_2026-10.md §6, built
// 2026-10-05): a member adds one out-stop from the normal (weekly) request form — a compact
// chip behind "+ עצירה" — and the stop shows up both on their own "/my" row (the shared
// `routeLabel()`, "דרך <stop> ל<destination>") and on the Sadran board's unmet-request card
// ("· 1 עצירות", the same marker a placed ride's block would carry).
const MEMBER_ID = "00000000-0000-0000-0000-000000000103"; // member1's profile id (seed.sql)
const HAIFA_ID = "00000000-0000-0000-0000-000000000011";
const BINYAMINA = "בנימינה";
const HAIFA = "חיפה";

test.use({ viewport: { width: 390, height: 844 } });

test.describe("multi-stop rides", { tag: ["@request-form", "@board"] }, () => {
  test("adding an out-stop shows it on /my, and the Sadran board's unmet card gets a stop count", async ({ page, browser }) => {
    const service = serviceRoleClient();
    const openWeekStart = await getWeekStart("open");
    await service.from("requests").delete()
      .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", openWeekStart)
      .eq("requester_id", MEMBER_ID).eq("destination_id", HAIFA_ID);

    await signIn(page, SEEDED_USERS.member1);
    await page.goto("/requests/new");
    await expect(page.getByText("בקשה חדשה")).toBeVisible();

    // A deterministic day (Sunday = openWeekStart itself) so the board check below looks at
    // the right day tab without guessing "today"'s weekday.
    await page.getByRole("radiogroup", { name: he.field.day }).getByRole("radio").first().click();

    // Destination: a real list place (so the board/unmet card resolves a clean name).
    await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
    await page.getByPlaceholder("לאן?").fill(HAIFA);
    await page.getByRole("option").filter({ hasText: HAIFA }).first().click();

    // Out-stop: collapsed behind "+ עצירה" until tapped (REQUIREMENTS §13.93 "Multi-stop
    // rides") — opens the same `DestinationCombobox`, auto-focused, and closes itself on pick.
    await page.getByRole("button", { name: he.request.addStop, exact: true }).click();
    await page.getByPlaceholder(he.request.stopPlaceholder).fill(BINYAMINA);
    await page.getByRole("option").filter({ hasText: BINYAMINA }).first().click();

    // The chip is visible and the "+ עצירה" link reappears (collapsed again, only one stop so
    // far — nothing extra stays visible until used).
    await expect(page.getByText(BINYAMINA)).toBeVisible();
    await expect(page.getByRole("button", { name: he.request.addStop, exact: true })).toBeVisible();

    await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();
    await page.getByRole("button", { name: t("action.submitRequest"), exact: true }).click();

    await expect(page).toHaveURL(/\/my$/);
    // "דרך בנימינה לחיפה" (REQUIREMENTS §13.93 "Multi-stop rides" Display) — the home-origin
    // request's one-line label names the out-stop even though the origin itself stays hidden.
    await expect(page.getByText(tv("route.toVia", { destination: HAIFA, stops: BINYAMINA }))).toBeVisible();

    const { data: created, error } = await service.from("requests").select("id")
      .eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", openWeekStart)
      .eq("requester_id", MEMBER_ID).eq("destination_id", HAIFA_ID).single();
    if (error) throw error;
    const { data: stops, error: stopsError } = await service.from("request_stops")
      .select("leg, position, place_id").eq("request_id", created!.id);
    if (stopsError) throw stopsError;
    expect(stops).toHaveLength(1);
    expect(stops![0]).toMatchObject({ leg: "out", position: 1 });
    expect(stops![0]!.place_id).toBeTruthy();

    const { context, page: sadranPage } = await newSignedInPage(browser, SEEDED_USERS.sadran);
    try {
      await sadranPage.setViewportSize({ width: 1440, height: 900 });
      await sadranPage.goto(`/sadran/${NEVO_DEPARTMENT_ID}/${openWeekStart}/board`);
      await sadranPage.getByRole("radio").first().click(); // same Sunday selected above
      const unmetCard = sadranPage.locator("[data-request-id]")
        .filter({ hasText: SEEDED_USERS.member1.fullName })
        .filter({ hasText: HAIFA });
      await expect(unmetCard).toHaveCount(1);
      // The stops by name, not a count (owner 2026-10-05).
      await expect(unmetCard.getByText(tv("route.viaStops", { stops: BINYAMINA }), { exact: false })).toBeVisible();
    } finally {
      await context.close();
    }

    await service.from("requests").delete().eq("id", created!.id);
  });
});
