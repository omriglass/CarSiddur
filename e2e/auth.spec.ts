import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

// Local-only Supabase stack (ARCHITECTURE.md §14: "Playwright runs against
// the local stack with seeded users bypassing Google"). The service-role
// key here is the fixed demo key `npx supabase status` prints for every
// project using the default local `config.toml` JWT secret — never a real
// secret, and never used against a hosted project.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const MEMBER_EMAIL = "member1@nevo.local";
const MEMBER_PASSWORD = "nevo-demo-1234";
const MEMBER_NAME = "חבר ראשון"; // supabase/seed.sql member_invites row for member1@nevo.local

// supabase/seed.sql seeds exactly 4 demo accounts (admin, sadran, member1,
// member2), all pre-approved via `member_invites` — none is left pending.
// We can't edit the seed (out of scope for this stage), but `handle_new_user()`
// marks *any* signed-up email not matching an invite as `approval_status =
// 'pending'`, so this spec creates one such account at runtime via the admin
// API instead of skipping the scenario.
const PENDING_EMAIL = "e2e-pending@nevo.local";
const PENDING_PASSWORD = "e2e-pending-1234";

async function ensurePendingUserExists() {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: existing } = await admin.auth.admin.listUsers();
  const alreadyExists = existing?.users.some((u) => u.email === PENDING_EMAIL);
  if (!alreadyExists) {
    const { error } = await admin.auth.admin.createUser({
      email: PENDING_EMAIL,
      password: PENDING_PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
  }
}

// Mobile viewport so the bottom tab bar (Tailwind `md:hidden`) is the one
// that's actually visible, matching UX_FLOWS.md §2.2's phone-first layout.
test.use({ viewport: { width: 390, height: 844 } });

test.describe("auth", () => {
  test("member signs in via the dev email form and reaches Home with the bottom tabs", async ({
    page,
  }) => {
    await page.goto("/login");

    await page.getByLabel("אימייל").fill(MEMBER_EMAIL);
    await page.getByLabel("סיסמה").fill(MEMBER_PASSWORD);
    await page.getByRole("button", { name: "התחברות", exact: true }).click();

    await expect(page).toHaveURL(/\/my$/);
    await expect(page.getByText("השבוע שלי")).toBeVisible();
    await expect(page.getByText(MEMBER_NAME).first()).toBeVisible();

    const bottomNav = page.getByRole("navigation").last();
    await expect(bottomNav.getByText("הסידור")).toBeVisible();
    await expect(bottomNav.getByText("הבקשות שלי")).toBeVisible();
    await expect(bottomNav.getByText("הודעות")).toBeVisible();
    await expect(bottomNav.getByText("פרופיל")).toBeVisible();
  });

  test("an unapproved account is sent to the pending page", async ({ page }) => {
    await ensurePendingUserExists();

    await page.goto("/login");
    await page.getByLabel("אימייל").fill(PENDING_EMAIL);
    await page.getByLabel("סיסמה").fill(PENDING_PASSWORD);
    await page.getByRole("button", { name: "התחברות", exact: true }).click();

    await expect(page).toHaveURL(/\/pending$/);
    await expect(page.getByText("ממתין לאישור")).toBeVisible();
    await expect(page.getByText(PENDING_EMAIL)).toBeVisible();
  });
});
