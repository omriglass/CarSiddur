import { expect, test } from "@playwright/test";

import { he, tv } from "../src/i18n/he";
import { NEVO_DEPARTMENT_ID, newSignedInPage, SEEDED_USERS, serviceRoleClient, submitRequestForm } from "./helpers";
import { publishedFixtureWeek } from "./published-week";
import { PLACES, PROFILE_IDS, RIDE_TYPE_WORK, reserveCar, setClassicForm, winterAt } from "./request-form";

// REQ §13.203 (d): a new round trip that lands on the waiting list offers "make room" when the only car in the way
// carries one driver's own round trip. The member picks what to ask (here: leave later), confirms they talked, and the
// other driver accepts from the inbox — the request is then placed on that car at its own hours.
const WEEK = "2041-01-13";
const DAY = WEEK; // Sunday, the form's first day
const DESTINATION = "בדיקת פינוי מקום";
const ASKED_CAR = "00000000-0000-0000-0000-000000000041";
const OTHER_CARS = ["00000000-0000-0000-0000-000000000040", "00000000-0000-0000-0000-000000000042"];

test.use({ actionTimeout: 15_000 });

test("a waitlisted new request asks the driver in the way to leave later; accepted, the request gets the car (REQ §13.203 d)", { tag: ["@request-form", "@notifications"] }, async ({ browser }) => {
  const service = serviceRoleClient();
  const admin = await publishedFixtureWeek(WEEK);
  await admin.auth.signOut();
  const contexts: { close: () => Promise<void> }[] = [];
  // Global setup puts every seeded user on the classic form; restore whatever was there, not the sentence form.
  const { data: before } = await service.from("profiles").select("classic_request_form").eq("email", SEEDED_USERS.member1.email).single();
  await setClassicForm(SEEDED_USERS.member1.email, true);
  try {
    // member2 drives car 41 09:00–17:00 alone (askable); the other shared cars are held all day by reservations (not askable).
    for (const car of OTHER_CARS) await reserveCar(service, WEEK, car, DAY, "06:00", "23:30");
    const { data: theirRequest, error: requestError } = await service.from("requests").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, requester_id: PROFILE_IDS.member2, filed_by: PROFILE_IDS.member2,
      ride_type_id: RIDE_TYPE_WORK, destination_text: "E2E in the way", trip_shape: "round_trip",
      depart_at: winterAt(DAY, "09:00"), return_at: winterAt(DAY, "17:00"), status: "assigned",
    }).select("id").single();
    if (requestError) throw requestError;
    const { data: theirRide, error: rideError } = await service.from("rides").insert({
      department_id: NEVO_DEPARTMENT_ID, week_start: WEEK, car_id: ASKED_CAR, driver_id: PROFILE_IDS.member2, created_by: PROFILE_IDS.member2,
      starts_at: winterAt(DAY, "09:00"), ends_at: winterAt(DAY, "17:00"), blocked_until: winterAt(DAY, "17:30"),
      origin_id: PLACES.home.id, destination_id: PLACES.home.id, status: "confirmed",
    }).select("id").single();
    if (rideError) throw rideError;
    const { error: linkError } = await service.from("ride_requests").insert({ ride_id: theirRide!.id, request_id: theirRequest!.id, role: "driver", leg: "both", car_mode: "keep" });
    if (linkError) throw linkError;

    const member1 = await newSignedInPage(browser, SEEDED_USERS.member1);
    contexts.push(member1.context);
    const page = member1.page;
    await page.goto(`/requests/new?week=${WEEK}`);
    await page.getByRole("combobox").first().click();
    await page.getByPlaceholder("לאן?").fill(DESTINATION);
    await page.getByText(`"${DESTINATION}" — יעד חופשי`).click();
    await page.getByRole("radiogroup", { name: "סוג נסיעה" }).getByRole("radio").first().click();
    await page.getByRole("radiogroup", { name: "יום" }).getByRole("radio").first().click();
    await submitRequestForm(page);

    // 08:00–12:00 on car 41 needs member2 to leave at 12:30 (turnaround 30): the smallest change, preselected.
    const dialog = page.getByRole("dialog").filter({ hasText: he.rideEditing.makeRoom.titleRequest });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("make-room-free-car")).toHaveCount(0);
    const leaveLater = tv("rideEditing.makeRoom.leaveLater", { time: "12:30", minutes: "210" });
    await expect(dialog.getByTestId("make-room-party").getByLabel(leaveLater)).toBeChecked();
    await expect(dialog.getByTestId("make-room-party").getByLabel(he.rideEditing.makeRoom.giveUp)).not.toBeChecked();
    await dialog.getByRole("button", { name: tv("rideEditing.makeRoom.send", { names: SEEDED_USERS.member2.fullName }) }).click();
    await expect(dialog).toHaveCount(0);

    const { data: mine } = await service.from("requests").select("id,status").eq("week_start", WEEK).eq("destination_text", DESTINATION).single();
    expect(mine!.status).toBe("waitlisted");
    const { data: change } = await service.from("ride_change_requests").select("status,talked,request_id").eq("request_id", mine!.id).single();
    expect(change).toMatchObject({ status: "pending", talked: true });

    const member2 = await newSignedInPage(browser, SEEDED_USERS.member2);
    contexts.push(member2.context);
    await member2.page.goto("/inbox");
    const accept = tv("rideEditing.acceptStart", { newTime: "12:30", minutes: "210" });
    await member2.page.getByRole("button", { name: accept }).click();
    await expect(member2.page.getByRole("button", { name: accept })).toHaveCount(0);

    const { data: theirAfter } = await service.from("rides").select("status,starts_at,ends_at").eq("id", theirRide!.id).single();
    expect(theirAfter!.status).toBe("confirmed");
    expect(new Date(theirAfter!.starts_at).toISOString()).toBe(new Date(winterAt(DAY, "12:30")).toISOString());
    const { data: placed } = await service.from("ride_requests").select("rides!inner(car_id,starts_at,ends_at,status)").eq("request_id", mine!.id);
    const ride = (placed ?? []).map((row) => row.rides as unknown as { car_id: string; starts_at: string; ends_at: string; status: string }).find((r) => r.status !== "cancelled");
    expect(ride?.car_id).toBe(ASKED_CAR);
    expect(new Date(ride!.starts_at).toISOString()).toBe(new Date(winterAt(DAY, "08:00")).toISOString());
    expect((await service.from("requests").select("status").eq("id", mine!.id).single()).data!.status).toBe("assigned");
    const { data: told } = await service.from("notifications").select("data").eq("recipient_id", PROFILE_IDS.member1).eq("week_start", WEEK);
    expect(told!.some((n) => (n.data as { variant?: string }).variant === "ride_shorten_accepted")).toBe(true);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
    await setClassicForm(SEEDED_USERS.member1.email, before?.classic_request_form ?? true);
    await service.from("ride_change_requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    const { data: rides } = await service.from("rides").select("id").eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    if (rides?.length) await service.from("ride_requests").delete().in("ride_id", rides.map((r) => r.id));
    await service.from("rides").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    await service.from("requests").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
    await service.from("notifications").delete().eq("department_id", NEVO_DEPARTMENT_ID).eq("week_start", WEEK);
  }
});
