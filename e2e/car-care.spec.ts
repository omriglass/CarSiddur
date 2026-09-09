import { expect, test } from "@playwright/test";

import { paths } from "../src/app/routes";
import { he, tv } from "../src/i18n/he";
import { getWeekStart, NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, signIn } from "./helpers";

/**
 * Car care portal (REQUIREMENTS §6.6, UX_FLOWS §3.9 / §5.11):
 * `CarNameWithReport` on a siddur ride card / ride detail opens `CarReportDialog`
 * (problem / tire fill / wash), each RPC notifies the car's `responsible_id`
 * (`data.url` -> `/cars/<car_id>`, `notification_default_url()`), and `/cars/:carId`
 * (`CarManageScreen`) is gated to the responsible person or an admin.
 *
 * Uses the seeded live week's ride (`supabase/seed.sql`) on whichever shared car the
 * seed gives a `responsible_id` — looked up at runtime rather than hardcoded (seed.sql
 * is the source of truth for exact ids), so this spec tracks seed changes automatically.
 */

const service = serviceRoleClient();

test("member logs car care (wash, tire fill, problem) and only the car's responsible / admin can view its history", async ({ page, browser }) => {
  // Several test.step blocks, three of them spinning up a fresh signed-in browser context
  // (mirrors freed-slot.spec.ts's multi-context flow) — comfortably under 60s in practice,
  // but the default test timeout leaves little margin.
  test.setTimeout(90_000);

  const liveWeek = await getWeekStart("live");

  const { data: car, error: carError } = await service
    .from("cars")
    .select("id, name, responsible_id")
    .eq("department_id", NEVO_DEPARTMENT_ID)
    .not("responsible_id", "is", null)
    .limit(1)
    .single();
  if (carError) throw carError;
  const carId: string = car!.id;
  const carName: string = car!.name;
  const responsibleId: string = car!.responsible_id;

  const { data: ride, error: rideError } = await service
    .from("rides")
    .select("id")
    .eq("department_id", NEVO_DEPARTMENT_ID)
    .eq("week_start", liveWeek)
    .eq("car_id", carId)
    .limit(1)
    .single();
  if (rideError) throw rideError;
  const rideId: string = ride!.id;

  const { data: responsibleProfile, error: profileError } = await service
    .from("profiles")
    .select("email")
    .eq("id", responsibleId)
    .single();
  if (profileError) throw profileError;
  const responsibleUser = Object.values(SEEDED_USERS).find((u) => u.email === responsibleProfile!.email);
  if (!responsibleUser) throw new Error(`car ${carId}'s responsible_id ${responsibleId} is not one of SEEDED_USERS`);

  // Any other seeded member (not the responsible person) files the reports and, in the
  // last step, stands in for "a non-responsible member" hitting the car page.
  const actorMember = [SEEDED_USERS.member1, SEEDED_USERS.member2].find((u) => u.email !== responsibleUser.email)!;

  let washEventId: string | null = null;
  let tireEventId: string | null = null;
  let issueId: string | null = null;
  let washNotificationId: string | null = null;
  let tireNotificationId: string | null = null;
  let issueNotificationId: string | null = null;

  try {
    await signIn(page, actorMember);
    await page.goto(paths.siddur({ dept: NEVO_DEPARTMENT_ID, week: liveWeek, rideId }));

    const rideSheet = page.getByRole("dialog");
    await expect(rideSheet.getByTestId("car-name-report-trigger")).toBeVisible();

    const reportDialog = page.getByRole("dialog", { name: tv("carCare.dialogTitle", { car: carName }) });

    await test.step("wash: one tap logs a wash and notifies the responsible person", async () => {
      await rideSheet.getByTestId("car-name-report-trigger").click();
      await expect(reportDialog).toBeVisible();

      await reportDialog.getByRole("button", { name: he.carCare.homeWashTitle }).click();
      await reportDialog.getByRole("button", { name: he.carCare.washButton }).click();
      await expect(reportDialog.getByText(he.carCare.washCelebration)).toBeVisible();

      const { data: events, error } = await service
        .from("car_care_events")
        .select("id, kind, tires, note")
        .eq("car_id", carId)
        .eq("kind", "wash")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      expect(events).toHaveLength(1);
      washEventId = events![0]!.id as string;
      expect(events![0]!.tires).toBeNull();

      const { data: notif, error: notifError } = await service
        .from("notifications")
        .select("id, recipient_id, event, data")
        .contains("data", { car_care_event_id: washEventId })
        .maybeSingle();
      if (notifError) throw notifError;
      const washData = notif!.data as Record<string, unknown>;
      expect(notif!.recipient_id).toBe(responsibleId);
      expect(notif!.event).toBe("car_care");
      expect(washData.variant).toBe("wash");
      expect(washData.car_id).toBe(carId);
      expect(washData.url).toBe(`/cars/${carId}`);
      washNotificationId = notif!.id as string;

      await expect(reportDialog).not.toBeVisible({ timeout: 3_000 });
    });

    await test.step("tire fill: two low, one very_low, two ok, plus a note", async () => {
      await rideSheet.getByTestId("car-name-report-trigger").click();
      await expect(reportDialog).toBeVisible();
      await reportDialog.getByRole("button", { name: he.carCare.homeTireFillTitle }).click();

      // low x2 (one tap each), very_low x1 (two taps), ok x2 (untouched).
      await reportDialog.getByTestId("tire-front_left").click();
      await reportDialog.getByTestId("tire-front_right").click();
      await reportDialog.getByTestId("tire-rear_left").click();
      await reportDialog.getByTestId("tire-rear_left").click();

      await reportDialog.getByLabel(he.carCare.tireNoteLabel).fill("Front-left and front-right were soft; rear-left almost flat");
      await reportDialog.getByRole("button", { name: he.carCare.tireDone }).click();
      await expect(reportDialog.getByText(he.carCare.tireCelebration)).toBeVisible();

      const { data: events, error } = await service
        .from("car_care_events")
        .select("id, kind, tires, note")
        .eq("car_id", carId)
        .eq("kind", "tire_fill")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      expect(events).toHaveLength(1);
      tireEventId = events![0]!.id as string;
      expect(events![0]!.tires).toEqual({
        front_left: "low",
        front_right: "low",
        rear_left: "very_low",
        rear_right: "ok",
        spare: "ok",
      });
      expect(events![0]!.note).toBe("Front-left and front-right were soft; rear-left almost flat");

      const { data: notif, error: notifError } = await service
        .from("notifications")
        .select("id, recipient_id, event, data")
        .contains("data", { car_care_event_id: tireEventId })
        .maybeSingle();
      if (notifError) throw notifError;
      const tireData = notif!.data as Record<string, unknown>;
      expect(notif!.recipient_id).toBe(responsibleId);
      expect(notif!.event).toBe("car_care");
      expect(tireData.variant).toBe("tire_fill");
      expect(tireData.car_id).toBe(carId);
      expect(tireData.url).toBe(`/cars/${carId}`);
      tireNotificationId = notif!.id as string;

      await expect(reportDialog).not.toBeVisible({ timeout: 3_000 });
    });

    await test.step("problem: mechanical category with an explanation", async () => {
      await rideSheet.getByTestId("car-name-report-trigger").click();
      await expect(reportDialog).toBeVisible();
      await reportDialog.getByRole("button", { name: he.carCare.homeProblemTitle }).click();

      await reportDialog.getByRole("radio", { name: he.carCare.category.mechanical }).click();
      await reportDialog.getByPlaceholder(he.carCare.descriptionPlaceholder).fill("Strange grinding noise from the front brakes");
      await reportDialog.getByRole("button", { name: he.carCare.submitProblem }).click();

      await expect(page.getByText(he.carCare.problemSuccessToast)).toBeVisible();
      await expect(reportDialog).not.toBeVisible();

      const { data: issues, error } = await service
        .from("car_issues")
        .select("id, category, description")
        .eq("car_id", carId)
        .eq("category", "mechanical")
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      expect(issues).toHaveLength(1);
      issueId = issues![0]!.id as string;
      expect(issues![0]!.description).toBe("Strange grinding noise from the front brakes");

      const { data: notif, error: notifError } = await service
        .from("notifications")
        .select("id, recipient_id, event, data")
        .contains("data", { issue_id: issueId })
        .maybeSingle();
      if (notifError) throw notifError;
      const issueData = notif!.data as Record<string, unknown>;
      expect(notif!.recipient_id).toBe(responsibleId);
      expect(notif!.event).toBe("car_care");
      expect(issueData.variant).toBe("issue_mechanical");
      expect(issueData.car_id).toBe(carId);
      expect(issueData.url).toBe(`/cars/${carId}`);
      issueNotificationId = notif!.id as string;
    });

    await test.step("the X closes the dialog without calling any RPC", async () => {
      const [{ count: eventsBefore }, { count: issuesBefore }] = await Promise.all([
        service.from("car_care_events").select("id", { count: "exact", head: true }).eq("car_id", carId),
        service.from("car_issues").select("id", { count: "exact", head: true }).eq("car_id", carId),
      ]);

      await rideSheet.getByTestId("car-name-report-trigger").click();
      await expect(reportDialog).toBeVisible();
      await reportDialog.getByTestId("car-report-close").click();
      await expect(reportDialog).not.toBeVisible();

      const [{ count: eventsAfter }, { count: issuesAfter }] = await Promise.all([
        service.from("car_care_events").select("id", { count: "exact", head: true }).eq("car_id", carId),
        service.from("car_issues").select("id", { count: "exact", head: true }).eq("car_id", carId),
      ]);
      expect(eventsAfter).toBe(eventsBefore);
      expect(issuesAfter).toBe(issuesBefore);
    });

    await test.step("the responsible person sees the wash, the tire fill and the issue on /cars/:carId's History tab", async () => {
      const { context, page: responsiblePage } = await newSignedInPage(browser, responsibleUser);
      try {
        await responsiblePage.goto(paths.car(carId));
        await expect(responsiblePage.getByRole("heading", { name: carName })).toBeVisible();

        await responsiblePage.getByRole("tab", { name: he.carPage.tabHistory }).click();
        await expect(responsiblePage.getByText(he.carPage.historyKindWash).first()).toBeVisible();
        await expect(responsiblePage.getByText(he.carPage.historyKindTireFill).first()).toBeVisible();
        await expect(responsiblePage.getByText(he.carCare.category.mechanical).first()).toBeVisible();
      } finally {
        await context.close();
      }
    });

    await test.step("a non-responsible member gets the not-authorized state", async () => {
      const { context, page: memberPage } = await newSignedInPage(browser, actorMember);
      try {
        await memberPage.goto(paths.car(carId));
        await expect(memberPage.getByText(he.errors.notAuthorized)).toBeVisible();
        await expect(memberPage.getByRole("heading", { name: carName })).not.toBeVisible();
      } finally {
        await context.close();
      }
    });

    await test.step("an admin can open the car page", async () => {
      const { context, page: adminPage } = await newSignedInPage(browser, SEEDED_USERS.admin);
      try {
        await adminPage.goto(paths.car(carId));
        await expect(adminPage.getByRole("heading", { name: carName })).toBeVisible();
        await expect(adminPage.getByText(he.errors.notAuthorized)).not.toBeVisible();
      } finally {
        await context.close();
      }
    });
  } finally {
    const notificationIds = ([washNotificationId, tireNotificationId, issueNotificationId] as (string | null)[]).filter(
      (id): id is string => !!id,
    );
    if (notificationIds.length) await service.from("notifications").delete().in("id", notificationIds);

    const eventIds = ([washEventId, tireEventId] as (string | null)[]).filter((id): id is string => !!id);
    if (eventIds.length) await service.from("car_care_events").delete().in("id", eventIds);

    if (issueId) await service.from("car_issues").delete().eq("id", issueId);
  }
});
