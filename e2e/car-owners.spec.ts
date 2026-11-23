import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, submitRequestForm } from "./helpers";
import { publishedFixtureWeek } from "./published-week";

/**
 * PC1 (REQ item 227): a private car with several owners. The seeded private car (`supabase/seed.sql`, owner member2):
 * member2 adds member1 on the car page; member1 is told, sees both owners and may manage them too; the last owner
 * cannot be removed (no ✕ on the only chip).
 */
const service = serviceRoleClient();
const PRIVATE_CAR = "00000000-0000-0000-0000-000000000043";
const MEMBER1 = "00000000-0000-0000-0000-000000000103";
const MEMBER2 = "00000000-0000-0000-0000-000000000104";

test("an owner adds a co-owner; the co-owner is told and can manage the owners", { tag: ["@car-owners"] }, async ({ browser }) => {
  test.setTimeout(90_000);
  // start from the seed: member2 the only owner
  await service.from("car_owners").delete().eq("car_id", PRIVATE_CAR).eq("profile_id", MEMBER1);

  await test.step("member2 adds member1", async () => {
    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member2);
    await page.goto(paths.car(PRIVATE_CAR));
    const card = page.getByTestId("car-owners-card");
    await expect(card.getByTestId("car-owner")).toHaveCount(1);
    await expect(card.getByTestId("car-owner-remove")).toHaveCount(0);   // the last owner stays
    await card.getByTestId("car-owners-add").click();
    await page.getByTestId("car-owners-pick").click();
    await page.getByRole("option", { name: SEEDED_USERS.member1.fullName }).click();
    await page.getByRole("button", { name: he.carPage.ownersAddSubmit }).click();
    await expect(page.getByText(he.carPage.ownerAdded)).toBeVisible();
    await expect(card.getByTestId("car-owner")).toHaveCount(2);
    await context.close();
  });

  await test.step("member1 is told and manages the owners too", async () => {
    const { data: notices } = await service.from("notifications").select("title_he")
      .eq("recipient_id", MEMBER1).eq("event", "private_car_changed");
    expect(notices?.length).toBe(1);

    const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member1);
    await page.goto(paths.car(PRIVATE_CAR));
    const card = page.getByTestId("car-owners-card");
    await expect(card.getByTestId("car-owner")).toHaveCount(2);
    await expect(card.getByText(tv("carPage.ownersMe", { name: SEEDED_USERS.member1.fullName }))).toBeVisible();
    await expect(card.getByTestId("car-owner-remove")).toHaveCount(2);
    await expect(card.getByTestId("car-owners-add")).toBeVisible();
    await context.close();
  });

  await service.from("car_owners").delete().eq("car_id", PRIVATE_CAR).eq("profile_id", MEMBER1);
  await service.from("notifications").delete().eq("recipient_id", MEMBER1).eq("event", "private_car_changed");
});

/**
 * PE1 (REQ item 263): the owner (member2) chooses "הורים משותפים" under "מי עוד יכול/ה להשתמש ברכב"; member1, who
 * shares a child with member2, books a round trip on the car from the request form - it lands straight on the car.
 */
test("a co-parent books the private car once the owner allows co-parents", { tag: ["@car-owners", "@request-form"] }, async ({ browser }) => {
  test.setTimeout(120_000);
  const WEEK = "2045-05-07";   // a Sunday this spec owns
  const DAY = "2045-05-08";
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK).eq("requester_id", MEMBER1);
  await service.from("cars").update({ use_scope: "owners" }).eq("id", PRIVATE_CAR);
  const { data: kid, error: kidError } = await service.from("children")
    .insert({ department_id: NEVO_DEPARTMENT_ID, full_name: "E2E PE1 kid" }).select("id").single();
  if (kidError) throw kidError;
  await service.from("child_guardians").insert([{ child_id: kid.id, profile_id: MEMBER2 }, { child_id: kid.id, profile_id: MEMBER1 }]);

  try {
    await test.step("the owner allows co-parents", async () => {
      const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member2);
      await page.goto(paths.car(PRIVATE_CAR));
      await expect(page.getByText(he.carPage.useScopeTitle)).toBeVisible();
      await page.getByTestId("car-use-scope").click();
      await page.getByTestId("car-use-scope-co_parents").click();
      await expect.poll(async () => (await service.from("cars").select("use_scope").eq("id", PRIVATE_CAR).single()).data?.use_scope)
        .toBe("co_parents");
      await context.close();
    });

    await test.step("the co-parent books it from the form", async () => {
      const { context, page } = await newSignedInPage(browser, SEEDED_USERS.member1);
      // no setting for a co-parent: it is the owners'
      await page.goto(paths.car(PRIVATE_CAR));
      await expect(page.getByTestId("car-owners-card")).toBeVisible();
      await expect(page.getByTestId("car-use-scope")).toHaveCount(0);
      await page.goto(paths.requests.new({ week: WEEK, day: DAY, time: "10:00", end: "12:00", car: PRIVATE_CAR }));
      await page.getByRole("combobox").filter({ hasText: "לאן?" }).click();
      await page.getByPlaceholder("לאן?").fill("חיפה");
      await page.getByRole("option").filter({ hasText: "חיפה" }).first().click();
      await submitRequestForm(page);
      await expect.poll(async () => {
        const { data } = await service.from("requests").select("status, ride_requests(rides(car_id))")
          .eq("week_start", WEEK).eq("requester_id", MEMBER1).neq("status", "withdrawn");
        const row = data?.[0] as { status: string; ride_requests: { rides: { car_id: string } | null }[] } | undefined;
        return row ? `${row.status}:${row.ride_requests[0]?.rides?.car_id ?? ""}` : "";
      }, { timeout: 15_000 }).toBe(`assigned:${PRIVATE_CAR}`);
      await context.close();
    });
  } finally {
    const { data: requests } = await service.from("requests").select("id").eq("week_start", WEEK).eq("requester_id", MEMBER1);
    const ids = (requests ?? []).map((r) => r.id);
    if (ids.length) {
      const { data: links } = await service.from("ride_requests").select("ride_id").in("request_id", ids);
      await service.from("ride_requests").delete().in("request_id", ids);
      for (const link of links ?? []) await service.from("rides").delete().eq("id", link.ride_id);
      await service.from("requests").delete().in("id", ids);
    }
    await service.from("children").delete().eq("id", kid.id);
    await service.from("cars").update({ use_scope: "co_parents" }).eq("id", PRIVATE_CAR);
    await service.from("notifications").delete().eq("recipient_id", MEMBER2).eq("event", "private_car_changed");
  }
});
