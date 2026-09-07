import { expect, test } from "@playwright/test";

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
