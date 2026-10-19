import { expect, test } from "@playwright/test";
import { CHANGELOG } from "../src/i18n/he.changelog";
import { tv } from "../src/i18n/he";
import { SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

/**
 * REQ §13.139: opening the app puts the newest "מה חדש" message in the member's inbox — once, with no push — and the
 * version line at the bottom of the profile opens every changelog, newest first.
 */
test("a new version's \"what's new\" lands quietly in the inbox, and the version line opens the history", { tag: ["@notifications"] }, async ({ page }) => {
  const service = serviceRoleClient();
  const memberId = "00000000-0000-0000-0000-000000000103";
  const latest = CHANGELOG[0]!;
  await service.from("notifications").delete().eq("recipient_id", memberId).eq("event", "changelog");
  try {
    await signIn(page, SEEDED_USERS.member1);
    await expect.poll(async () => (await service.from("notifications").select("id").eq("recipient_id", memberId).eq("event", "changelog")).data?.length ?? 0).toBe(1);
    const { data: rows } = await service.from("notifications").select("id").eq("recipient_id", memberId).eq("event", "changelog");
    const { data: pushes } = await service.from("push_outbox").select("id").in("notification_id", rows!.map((row) => row.id));
    expect(pushes).toHaveLength(0);

    await page.goto("/inbox");
    await expect(page.getByText(tv("changelog.inboxTitle", { title: latest.title }))).toBeVisible();

    // Opening the app again does not deliver it twice.
    await page.reload();
    await expect.poll(async () => (await service.from("notifications").select("id").eq("recipient_id", memberId).eq("event", "changelog")).data?.length ?? 0).toBe(1);

    await page.goto("/profile");
    await page.getByTestId("profile-version-changelog").click();
    await expect(page).toHaveURL(/\/changelog$/);
    await expect(page.getByTestId("changelog-entry")).toHaveCount(CHANGELOG.length);
    await expect(page.getByTestId("changelog-entry").first()).toContainText(latest.title);
  } finally {
    await service.from("notifications").delete().eq("recipient_id", memberId).eq("event", "changelog");
  }
});
