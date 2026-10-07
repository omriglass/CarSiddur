import { expect, test } from "@playwright/test";

import { he } from "../src/i18n/he";
import { newSignedInPage, SEEDED_USERS, serviceRoleClient } from "./helpers";

/**
 * `/admin/errors` (REQ §13.108 E1, UX_FLOWS.md §5.13): an admin reads the latest browser errors from
 * `client_errors`; the route is admin-only, a plain member is sent back to `/my`.
 */
test.describe("admin client errors screen", { tag: ["@admin"] }, () => {
  test("an admin sees a reported error in the list; a member cannot open the route", async ({ browser }) => {
    const service = serviceRoleClient();
    const message = `E2E client error ${Date.now()}`;
    const { error } = await service.from("client_errors").insert({
      message, stack: "Error: e2e\n    at fixture (e2e.ts:1:1)", url: "/my", app_version: "e2e-1.0", user_agent: "Playwright",
    });
    if (error) throw error;
    const contexts: { close: () => Promise<void> }[] = [];
    try {
      await test.step("admin sees the row", async () => {
        const admin = await newSignedInPage(browser, SEEDED_USERS.admin);
        contexts.push(admin.context);
        await admin.page.goto("/admin/errors");
        await expect(admin.page.getByRole("heading", { name: he.adminErrors.title })).toBeVisible();
        const list = admin.page.getByTestId("client-errors-list");
        await expect(list).toBeVisible();
        const row = list.getByRole("listitem").filter({ hasText: message });
        await expect(row).toHaveCount(1);
        await expect(row).toContainText("e2e-1.0");
      });

      await test.step("a member is blocked by the route guard", async () => {
        const member = await newSignedInPage(browser, SEEDED_USERS.member1);
        contexts.push(member.context);
        await member.page.goto("/admin/errors");
        await expect(member.page).toHaveURL(/\/my$/);
        await expect(member.page.getByTestId("client-errors-list")).toHaveCount(0);
        await expect(member.page.getByText(message)).toHaveCount(0);
      });
    } finally {
      for (const context of contexts) await context.close().catch(() => undefined);
      await service.from("client_errors").delete().eq("message", message);
    }
  });
});
