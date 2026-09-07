import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, serviceRoleClient } from "./helpers";

// Member-facing flows (stage 2a), on top of the seeded local stack
// (supabase/seed.sql: member1@nevo.local is a member of department "נבו",
// which has a Live week with a confirmed ride to חיפה and an Open week with
// a couple of submitted requests, ARCHITECTURE.md §14).
const MEMBER_EMAIL = "member1@nevo.local";
const MEMBER_PASSWORD = "nevo-demo-1234";

test.use({ viewport: { width: 390, height: 844 } });

async function signIn(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.getByLabel("אימייל").fill(MEMBER_EMAIL);
  await page.getByLabel("סיסמה").fill(MEMBER_PASSWORD);
  await page.getByRole("button", { name: "התחברות", exact: true }).click();
  await expect(page).toHaveURL(/\/my$/);
}

test.describe("member", () => {
  test("submits a request for the open week and sees it in /requests as submitted", async ({ page }) => {
    await signIn(page);

    await page.goto("/requests/new");
    await expect(page.getByText("בקשה חדשה")).toBeVisible();

    // Destination: free text (always offered as the last combobox row).
    await page.getByRole("combobox").first().click();
    await page.getByPlaceholder("לאן?").fill("עפולה");
    await page.getByText('"עפולה" — יעד חופשי').click();

    // Ride type: first chip (סוג נסיעה row).
    await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();

    await page.getByRole("button", { name: "שלח/י בקשה" }).click();

    await expect(page).toHaveURL(/\/requests$/);
    await expect(page.getByText("עפולה").first()).toBeVisible();
    await expect(page.getByText("נשלחה").first()).toBeVisible();
  });

  test("opens /siddur for the seeded live week and sees at least one ride", async ({ page }) => {
    await signIn(page);

    await page.goto("/siddur");
    await expect(page.getByRole("heading", { name: "הסידור" })).toBeVisible();

    // The day-list defaults to "today in Jerusalem", which is always inside the
    // live week (by definition — REQUIREMENTS §5.5) but not necessarily a day
    // that has a ride, so check every day chip rather than assuming a specific
    // one. Every `RideCard` shows its driver ("נהג/ת:" or "הסעה · מסיע/ה:"),
    // which nothing else on this screen renders.
    // Not `exact: true`: the "today" chip's accessible name gets the extra
    // "היום" dot label appended (WeekStrip.tsx), e.g. "א היום" instead of "א".
    const dayLabels = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
    let sawARide = false;
    for (const label of dayLabels) {
      await page.getByRole("radio", { name: label }).first().click();
      if ((await page.getByText("נהג", { exact: false }).count()) > 0) {
        sawARide = true;
        break;
      }
    }
    expect(sawARide).toBe(true);
  });

  // UX_FLOWS.md §20: the member siddur's wide-screen grid used to show the
  // department's own name ("נבו") instead of the real destination for a
  // round trip (`ride.destination_id === origin_id === home`, DATA_MODEL.md
  // consistency decision #14) — the same bug the Sadran board fixed for
  // itself (`src/lib/rideLabel.ts`) but never wired into the member-facing
  // screens. A wide viewport is needed here since the grid only renders
  // `lg:` and up (`SiddurPage.tsx`); every ride block's `aria-label` is the
  // composed "<driver> ל/מ<place>" label (same convention `board.spec.ts`
  // already asserts for the Sadran board).
  test("wide-screen siddur grid shows the real destination, not the department name, on a ride block", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);

    await page.goto("/siddur");
    await expect(page.getByRole("heading", { name: "הסידור" })).toBeVisible();

    const dayLabels = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];
    let label: string | null = null;
    for (const dayLabel of dayLabels) {
      await page.getByRole("radiogroup", { name: "יום" }).last().getByRole("radio", { name: dayLabel }).first().click();
      const firstRide = page.locator("button[data-ride-id]").first();
      if (await firstRide.isVisible()) {
        label = await firstRide.getAttribute("aria-label");
        break;
      }
    }
    expect(label).toBeTruthy();
    expect(label).toMatch(/[למ]\S/);
    expect(label).not.toBe("נבו");
  });
});


test("member edits own request, saves directional flexibility, and confirms scoped rescinding", async ({ page }) => {
  const service = serviceRoleClient();
  const weekStart = "2040-01-01"; // Isolated Sunday; does not disturb the seeded open week.
  const memberId = "00000000-0000-0000-0000-000000000103";
  const otherMemberId = "00000000-0000-0000-0000-000000000104";
  const now = Date.now();
  const { error: weekError } = await service.from("weeks").insert({
    department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, phase: "open",
    open_at: new Date(now - 86_400_000).toISOString(), close_at: new Date(now + 86_400_000).toISOString(),
    publish_at: new Date(now + 172_800_000).toISOString(),
  });
  if (weekError) throw weekError;
  let cleanupError: unknown = null;
  try {
    const { data: requests, error } = await service.from("requests").insert([
      { requester_id: memberId, destination_text: "E2E editable request" },
      { requester_id: memberId, destination_text: "E2E second request" },
      { requester_id: otherMemberId, destination_text: "E2E someone else's request" },
    ].map((row, index) => ({
      ...row, department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, filed_by: row.requester_id,
      ride_type_id: "00000000-0000-0000-0000-000000000021", trip_shape: "round_trip",
      depart_at: `${weekStart}T${index === 1 ? "13" : "08"}:00:00+02:00`, return_at: `${weekStart}T${index === 1 ? "15" : "12"}:00:00+02:00`, status: row.requester_id === memberId ? "assigned" : "submitted",
    }))).select("id, requester_id");
    if (error) throw error;
    const mine = requests!.filter((row) => row.requester_id === memberId);
    const other = requests!.find((row) => row.requester_id === otherMemberId)!;
    const { data: car } = await service.from("cars").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("type", "shared").limit(1).single();
    const { data: department } = await service.from("departments").select("home_destination_id").eq("id", NEVO_DEPARTMENT_ID).single();
    const draftIds: string[] = [];
    for (const [index, request] of mine.entries()) {
      const { data: draft, error: draftError } = await service.from("rides").insert({
        department_id: NEVO_DEPARTMENT_ID, week_start: weekStart, car_id: car!.id,
        driver_id: memberId, created_by: memberId, status: "draft", origin_id: department!.home_destination_id,
        destination_id: department!.home_destination_id, starts_at: `${weekStart}T${index === 0 ? "08" : "13"}:00:00+02:00`,
        ends_at: `${weekStart}T${index === 0 ? "12" : "15"}:00:00+02:00`, blocked_until: `${weekStart}T${index === 0 ? "12" : "15"}:30:00+02:00`,
      }).select("id").single();
      if (draftError) throw draftError;
      draftIds.push(draft!.id);
      const { error: linkError } = await service.from("ride_requests").insert({ request_id: request.id, ride_id: draft!.id, role: "driver", car_mode: "keep", leg: "both" });
      if (linkError) throw linkError;
    }
    const { error: solvingError } = await service.from("weeks").update({ phase: "solving" }).eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    if (solvingError) throw solvingError;
    await signIn(page);
    await page.goto(`/requests/${mine[0]!.id}/edit`);
    await expect(page.getByRole("button", { name: he.action.saveRequest })).toBeVisible();
    await page.getByLabel(he.request.flexLater).first().click();
    await page.getByText(he.flex["30"], { exact: true }).first().click();
    await page.locator("textarea").fill("Updated through member request form");
    await page.getByRole("button", { name: he.action.saveRequest }).click();
    await expect(page).toHaveURL(/\/requests$/);
    const { data: edited } = await service.from("requests").select("notes, flex_depart_early, flex_depart_late").eq("id", mine[0]!.id).single();
    expect(edited).toMatchObject({ notes: "Updated through member request form", flex_depart_early: "00:00:00", flex_depart_late: "00:30:00" });
    const { data: released } = await service.from("rides").select("status").eq("id", draftIds[0]).single();
    expect(released?.status).toBe("cancelled");

    await page.goto(`/requests/${other.id}/edit`);
    await expect(page.getByText(he.request.notFound)).toBeVisible();
    await page.goto("/requests");
    const weekSection = page.locator("section").filter({ has: page.getByText("E2E editable request", { exact: true }) });
    await weekSection.getByRole("button", { name: he.requestsList.withdrawAll }).click();
    await page.getByRole("dialog").getByRole("button", { name: he.common.cancel }).click();
    const { data: untouched } = await service.from("requests").select("status").eq("id", mine[0]!.id).single();
    expect(untouched?.status).toBe("submitted");
    await weekSection.getByRole("button", { name: he.requestsList.withdrawAll }).click();
    await page.getByRole("dialog").getByRole("button", { name: he.requestsList.withdrawAll }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    const { data: after } = await service.from("requests").select("id, requester_id, status").eq("week_start", weekStart).eq("department_id", NEVO_DEPARTMENT_ID);
    const withdrawn = after!.filter((row) => row.requester_id === memberId);
    expect(withdrawn).toHaveLength(2);
    expect(withdrawn.every((row) => row.status === "withdrawn")).toBe(true);
    expect(after!.find((row) => row.id === other.id)?.status).toBe("submitted");
    const { data: draftsAfter } = await service.from("rides").select("status").in("id", draftIds);
    expect(draftsAfter).toHaveLength(2);
    expect(draftsAfter!.every((ride) => ride.status === "cancelled")).toBe(true);
  } finally {
    const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((ride) => ride.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    const cleanup = await service.from("weeks").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", weekStart);
    cleanupError = cleanup.error;
  }
  expect(cleanupError).toBeNull();
});
