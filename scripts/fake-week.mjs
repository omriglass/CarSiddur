#!/usr/bin/env node
// Fake-data generator for manual testing (local Supabase only). Creates a pool of fake
// department members and submits realistic ride requests for them via `submit_request`
// (the real RPC, signed in as each member with an anon client) so RLS/validation are
// exercised exactly like the member-facing form does (src/features/requests/mapper.ts).
//
// Usage:
//   node scripts/fake-week.mjs [--count 40] [--members 12] [--week YYYY-MM-DD]
//                              [--dept נבו|nevo] [--seed 42] [--clear]
//                              [--shabbat] [--allow-remote]
//
// Never touches ../commucar-share. Does not write to src/, supabase/migrations or seed.sql.

import { execSync } from "node:child_process";

import { createClient } from "@supabase/supabase-js";
import { addDays, format } from "date-fns";
import { fromZonedTime } from "date-fns-tz";

const TZ = "Asia/Jerusalem";
const FAKE_PASSWORD = "nevo-demo-1234";
const ADMIN_EMAIL = "admin@nevo.local";
const ADMIN_PASSWORD = "nevo-demo-1234";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    count: 40,
    members: 12,
    week: null,
    dept: "נבו",
    seed: 42,
    clear: false,
    shabbat: false,
    allowRemote: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--count":
        args.count = Number(argv[++i]);
        break;
      case "--members":
        args.members = Number(argv[++i]);
        break;
      case "--week":
        args.week = argv[++i];
        break;
      case "--dept":
        args.dept = argv[++i];
        break;
      case "--seed":
        args.seed = Number(argv[++i]);
        break;
      case "--clear":
        args.clear = true;
        break;
      case "--shabbat":
        args.shabbat = true;
        break;
      case "--allow-remote":
        args.allowRemote = true;
        break;
      default:
        console.warn(`fake-week: ignoring unknown argument "${a}"`);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic given --seed.
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function chance(rng, p) {
  return rng() < p;
}

/** weights: [[value, weight], ...] */
function weightedPick(rng, weights) {
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [value, w] of weights) {
    if (r < w) return value;
    r -= w;
  }
  return weights[weights.length - 1][0];
}

// ---------------------------------------------------------------------------
// Hebrew name pool for fake members (built-in, deterministic by index).
// ---------------------------------------------------------------------------
const FIRST_NAMES_M = ["איתן", "נועם", "עידו", "יובל", "אורי", "טל", "גיא", "רון", "עמית", "דניאל", "אלון", "שחר"];
const FIRST_NAMES_F = ["מאיה", "נועה", "שירה", "טליה", "יעל", "אביגיל", "רותם", "הדר", "עדי", "ליאור", "אור", "קרן"];
const LAST_NAMES = [
  "כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אזולאי", "דהן", "אבוטבול", "בן דוד", "גולן",
  "שרון", "נחום", "אלוני", "שדה", "קרמר", "ברק", "עמרם", "צור", "רימון", "שגיא",
];

function fakeMemberName(index, rng) {
  const isMale = index % 2 === 0;
  const first = isMale ? pick(rng, FIRST_NAMES_M) : pick(rng, FIRST_NAMES_F);
  const last = pick(rng, LAST_NAMES);
  return `${first} ${last}`;
}

// A handful of realistic free-text destinations (~10% of requests use these instead of a
// preset row from `destinations`), matching REQ §5.1's "type your own place" escape hatch.
const FREE_TEXT_DESTINATIONS = [
  "רופא שיניים בבנימינה",
  "פגישת הורים בבית ספר",
  "מספרה בזכרון יעקב",
  "בדיקת דם במרפאה",
  "אירוע משפחתי בחיפה",
  "חוג התעמלות",
];

const NOTES_POOL = [
  "צריך/ה לצאת בול בזמן, יש פגישה קבועה",
  "אפשר גם מעט מוקדם יותר אם נוח",
  "יש עמי מזוודה גדולה",
  "תודה מראש!",
  "גמיש/ה בשעת החזרה",
];

// ---------------------------------------------------------------------------
// Local-stack discovery (`npx supabase status -o env`), falling back to the
// well-known local defaults (same values e2e/helpers.ts already relies on).
// ---------------------------------------------------------------------------
const FALLBACK_ENV = {
  API_URL: "http://127.0.0.1:54321",
  ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
  SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
};

function readSupabaseStatusEnv() {
  try {
    const out = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const env = {};
    for (const line of out.split("\n")) {
      const m = /^([A-Z0-9_]+)="(.*)"$/.exec(line.trim());
      if (m) env[m[1]] = m[2];
    }
    return env;
  } catch {
    return {};
  }
}

function resolveConnection(allowRemote) {
  const statusEnv = readSupabaseStatusEnv();
  const url = process.env.VITE_SUPABASE_URL || statusEnv.API_URL || FALLBACK_ENV.API_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || statusEnv.ANON_KEY || FALLBACK_ENV.ANON_KEY;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || statusEnv.SERVICE_ROLE_KEY || FALLBACK_ENV.SERVICE_ROLE_KEY;

  const hostname = new URL(url).hostname;
  const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
  if (!isLocal && !allowRemote) {
    throw new Error(
      `fake-week refuses to run against non-local URL "${url}" (pass --allow-remote to override).`,
    );
  }
  return { url, anonKey, serviceRoleKey };
}

// ---------------------------------------------------------------------------
// Department / fake members
// ---------------------------------------------------------------------------
async function resolveDepartment(admin, deptArg) {
  const { data, error } = await admin
    .from("departments")
    .select("id, name, slug, home_destination_id")
    .or(`name.eq.${deptArg},slug.eq.${deptArg}`)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`fake-week: no department found matching "${deptArg}" (name or slug).`);
  return data;
}

function fakeEmail(index) {
  return `fake${String(index).padStart(2, "0")}@nevo.local`;
}

function fakePhone(index) {
  return `+972501${String(index).padStart(6, "0")}`;
}

/** Ensures `count` fake members exist in the department (idempotent). Returns their profiles. */
async function ensureFakeMembers(admin, dept, count, rng) {
  const members = [];
  for (let i = 1; i <= count; i++) {
    const email = fakeEmail(i);
    const fullName = fakeMemberName(i, rng);
    const phone = fakePhone(i);

    const { data: existingProfile, error: profileLookupError } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("email", email)
      .maybeSingle();
    if (profileLookupError) throw profileLookupError;

    if (existingProfile) {
      // Make sure the department membership is still active (idempotent re-runs).
      await admin
        .from("department_members")
        .upsert(
          { department_id: dept.id, profile_id: existingProfile.id, role: "member", removed_at: null },
          { onConflict: "department_id,profile_id" },
        );
      members.push({ id: existingProfile.id, email, fullName: existingProfile.full_name, created: false });
      continue;
    }

    // member_invites is the allow-list `handle_new_user()` consumes on auth.users insert
    // (supabase/migrations/20260907090100_identity.sql) — mirrors how seed.sql provisions
    // the 4 demo accounts.
    const { error: inviteError } = await admin.from("member_invites").upsert(
      {
        email,
        full_name: fullName,
        phone,
        department_id: dept.id,
        role: "member",
        consumed_at: null,
      },
      { onConflict: "email" },
    );
    if (inviteError) throw inviteError;

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: FAKE_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError) throw new Error(`fake-week: could not create auth user ${email}: ${createError.message}`);

    // handle_new_user() runs synchronously in the same INSERT trigger, so the profile +
    // department_members row already exist by the time createUser() resolves.
    const profileId = created.user.id;
    members.push({ id: profileId, email, fullName, created: true });
  }
  return members;
}

async function signInMembers(url, anonKey, members) {
  const clients = [];
  for (const member of members) {
    const client = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await client.auth.signInWithPassword({ email: member.email, password: FAKE_PASSWORD });
    if (error) throw new Error(`fake-week: could not sign in as ${member.email}: ${error.message}`);
    clients.push(client);
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Week resolution
// ---------------------------------------------------------------------------
async function resolveWeek(admin, url, anonKey, dept, weekArg) {
  if (weekArg) {
    const { data: existing, error } = await admin
      .from("weeks")
      .select("department_id, week_start, phase")
      .eq("department_id", dept.id)
      .eq("week_start", weekArg)
      .maybeSingle();
    if (error) throw error;
    if (existing) return existing;

    // Not open yet — create it via `open_week` as the seeded admin (RPC contract:
    // supabase/migrations/20260907091500_rpc.sql, requires can_manage_week()).
    const adminClient = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error: signInError } = await adminClient.auth.signInWithPassword({
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    });
    if (signInError) throw new Error(`fake-week: could not sign in as admin to open week: ${signInError.message}`);
    const { error: openError } = await adminClient.rpc("open_week", {
      p_department_id: dept.id,
      p_week_start: weekArg,
    });
    if (openError) throw new Error(`fake-week: open_week(${weekArg}) failed: ${openError.message}`);

    const { data: created, error: refetchError } = await admin
      .from("weeks")
      .select("department_id, week_start, phase")
      .eq("department_id", dept.id)
      .eq("week_start", weekArg)
      .maybeSingle();
    if (refetchError) throw refetchError;
    if (!created) throw new Error(`fake-week: week ${weekArg} still missing after open_week().`);
    return created;
  }

  const { data: openWeek, error } = await admin
    .from("weeks")
    .select("department_id, week_start, phase")
    .eq("department_id", dept.id)
    .eq("phase", "open")
    .order("week_start", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!openWeek) {
    throw new Error(
      "fake-week: no Open week found for this department. Run `npm run db:reset` or pass --week YYYY-MM-DD.",
    );
  }
  return openWeek;
}

// ---------------------------------------------------------------------------
// Clearing previous fake requests (FK-safe delete order; no RPC covers "bulk
// withdraw by other member" so this uses the service-role client directly).
// ---------------------------------------------------------------------------
async function clearFakeRequests(admin, dept, week, members) {
  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) return 0;

  const { data: existing, error } = await admin
    .from("requests")
    .select("id")
    .eq("department_id", dept.id)
    .eq("week_start", week.week_start)
    .in("requester_id", memberIds);
  if (error) throw error;
  const requestIds = (existing ?? []).map((r) => r.id);
  if (requestIds.length === 0) return 0;

  // proposals.request_id / freed_slot_claims.request_id / freed_slot_offers.winning_request_id
  // have no ON DELETE CASCADE (supabase/migrations/20260907090900_proposals.sql,
  // 20260907091100_freed_slots.sql) — clear those first. ride_requests and
  // request_companions do cascade, but deleting explicitly keeps intent obvious.
  await admin.from("proposals").delete().in("request_id", requestIds);
  await admin.from("freed_slot_claims").delete().in("request_id", requestIds);
  await admin.from("freed_slot_offers").update({ winning_request_id: null }).in("winning_request_id", requestIds);
  await admin.from("ride_requests").delete().in("request_id", requestIds);
  await admin.from("request_companions").delete().in("request_id", requestIds);
  const { error: deleteError } = await admin.from("requests").delete().in("id", requestIds);
  if (deleteError) throw deleteError;
  return requestIds.length;
}

// ---------------------------------------------------------------------------
// Catalog data
// ---------------------------------------------------------------------------
async function fetchRideTypes(admin) {
  const { data, error } = await admin.from("ride_types").select("id, code, name_he");
  if (error) throw error;
  const byCode = {};
  for (const row of data ?? []) byCode[row.code] = row;
  return byCode;
}

async function fetchDestinations(admin, dept) {
  const { data, error } = await admin
    .from("destinations")
    .select("id, name, zone")
    .eq("is_approved", true)
    .neq("id", dept.home_destination_id);
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------
// Request generation (mirrors src/features/requests/mapper.ts's payload shape).
// ---------------------------------------------------------------------------
const RIDE_TYPE_WEIGHTS = [
  ["work", 0.35],
  ["childcare", 0.2],
  ["healthcare", 0.15],
  ["errands", 0.25],
  ["other", 0.05],
];

const DURATION_HOURS_BY_TYPE = {
  work: [8, 10],
  childcare: [3, 6],
  healthcare: [2, 4],
  errands: [1, 3],
  other: [2, 5],
};

/** Rounds a minute-of-day value down to the nearest 15-minute grid line. */
function toQuarterHour(minutes) {
  return Math.floor(minutes / 15) * 15;
}

function minutesToHHMM(minutes) {
  const clamped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Departure time clustered morning/afternoon peaks, with a smaller midday share. */
function pickDepartMinutes(rng) {
  const bucket = weightedPick(rng, [
    ["morning", 0.45],
    ["afternoon", 0.4],
    ["midday", 0.15],
  ]);
  let start;
  let end;
  if (bucket === "morning") {
    start = 6 * 60 + 30;
    end = 9 * 60;
  } else if (bucket === "afternoon") {
    start = 15 * 60;
    end = 19 * 60;
  } else {
    start = 11 * 60;
    end = 14 * 60;
  }
  return toQuarterHour(randInt(rng, start, end));
}

/** Day-of-week index (0 = Sunday .. 6 = Saturday), fewer on Friday, none on Saturday unless --shabbat. */
function pickDayIndex(rng, allowShabbat) {
  const weights = [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
    [5, 0.5],
  ];
  if (allowShabbat) weights.push([6, 0.3]);
  return weightedPick(rng, weights);
}

function pickFlexInterval(rng) {
  const bucket = weightedPick(rng, [
    ["none", 0.4],
    ["small", 0.4],
    ["wide", 0.2],
  ]);
  if (bucket === "none") return "0";
  if (bucket === "small") return chance(rng, 0.5) ? "30 min" : "1 hour";
  return chance(rng, 0.5) ? "2 hours" : "1 day";
}

/** `minutes` may be >= 1440 (past midnight) or negative; rolls `dayDate` forward/back accordingly. */
function toInstant(dayDate, minutes) {
  const dayOffset = Math.floor(minutes / 1440);
  const wrapped = minutes - dayOffset * 1440;
  const date = dayOffset === 0 ? dayDate : format(addDays(new Date(`${dayDate}T00:00:00`), dayOffset), "yyyy-MM-dd");
  return fromZonedTime(`${date}T${minutesToHHMM(wrapped)}:00`, TZ).toISOString();
}

/**
 * Builds one `submit_request` payload. `forcedDayIndex`/`forcedDepartMinutes`/`forcedRideType`
 * let the caller inject deliberate collisions (several work rides at the same time).
 */
function buildRequestPlan(rng, { weekStart, rideTypes, destinations, members, requesterIndex, options }) {
  const rideTypeCode = options.forcedRideType ?? weightedPick(rng, RIDE_TYPE_WEIGHTS);
  const rideType = rideTypes[rideTypeCode];

  const dayIndex = options.forcedDayIndex ?? pickDayIndex(rng, options.allowShabbat);
  const dayDate = format(addDays(new Date(`${weekStart}T00:00:00`), dayIndex), "yyyy-MM-dd");

  const tripShape = weightedPick(rng, [
    ["round_trip", 0.75],
    ["one_way_to", 0.15],
    ["one_way_from", 0.1],
  ]);

  const departMinutes = options.forcedDepartMinutes ?? pickDepartMinutes(rng);
  const [durMin, durMax] = DURATION_HOURS_BY_TYPE[rideTypeCode] ?? [2, 5];
  const durationMinutes = toQuarterHour(randInt(rng, durMin * 60, durMax * 60));

  const needsDepart = tripShape !== "one_way_from";
  const needsReturn = tripShape !== "one_way_to";

  const payload = {
    department_id: null, // filled by caller
    week_start: weekStart,
    ride_type_id: rideType.id,
    trip_shape: tripShape,
  };

  if (needsDepart) payload.depart_at = toInstant(dayDate, departMinutes);
  if (needsReturn) {
    let returnMinutes = needsDepart ? departMinutes + durationMinutes : departMinutes;
    // Requests must stay inside the target week (requests_within_week() trigger); a Saturday
    // ride rolling into the following Sunday would violate that, so clamp same-day instead.
    if (dayIndex === 6 && returnMinutes >= 1440) returnMinutes = 23 * 60 + 45; // 23:45, stays on the 15-min grid
    payload.return_at = toInstant(dayDate, returnMinutes);
  }

  if (tripShape !== "round_trip") {
    payload.one_way_car_mode = chance(rng, 0.5) ? "relay" : "passenger";
  } else {
    payload.needs_car_at_destination = !chance(rng, 0.3);
  }

  if (chance(rng, 0.1) && FREE_TEXT_DESTINATIONS.length > 0) {
    payload.destination_text = pick(rng, FREE_TEXT_DESTINATIONS);
  } else if (destinations.length > 0) {
    payload.destination_id = pick(rng, destinations).id;
  } else {
    payload.destination_text = pick(rng, FREE_TEXT_DESTINATIONS);
  }

  const childcareBoost = rideTypeCode === "childcare";
  payload.adults = weightedPick(rng, [
    [1, 0.7],
    [2, 0.2],
    [3, 0.07],
    [4, 0.03],
  ]);
  payload.child_seats = chance(rng, childcareBoost ? 0.45 : 0.15) ? randInt(rng, 1, 2) : 0;
  payload.boosters = chance(rng, 0.08) ? 1 : 0;
  payload.has_luggage = chance(rng, 0.1);

  payload.flex_depart_early = pickFlexInterval(rng);
  payload.flex_depart_late = pickFlexInterval(rng);
  payload.flex_return_early = pickFlexInterval(rng);
  payload.flex_return_late = pickFlexInterval(rng);

  if (chance(rng, 0.15)) payload.notes = pick(rng, NOTES_POOL);

  let companionIndex = null;
  if (chance(rng, 0.08) && members.length > 1) {
    let idx = requesterIndex;
    while (idx === requesterIndex) idx = randInt(rng, 0, members.length - 1);
    companionIndex = idx;
  }

  return { payload, rideTypeCode, tripShape, dayIndex, companionIndex };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isFinite(args.count) || args.count <= 0) throw new Error("fake-week: --count must be a positive number");
  if (!Number.isFinite(args.members) || args.members <= 0) throw new Error("fake-week: --members must be a positive number");

  const rng = mulberry32(args.seed);
  const { url, anonKey, serviceRoleKey } = resolveConnection(args.allowRemote);

  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`fake-week: connecting to ${url}`);
  const dept = await resolveDepartment(admin, args.dept);
  console.log(`fake-week: department "${dept.name}" (${dept.slug})`);

  const members = await ensureFakeMembers(admin, dept, args.members, rng);
  const createdCount = members.filter((m) => m.created).length;
  console.log(
    `fake-week: ${members.length} fake members ready (${createdCount} newly created, ${
      members.length - createdCount
    } reused)`,
  );

  const week = await resolveWeek(admin, url, anonKey, dept, args.week);
  console.log(`fake-week: target week ${week.week_start} (phase: ${week.phase})`);

  if (args.clear) {
    const cleared = await clearFakeRequests(admin, dept, week, members);
    console.log(`fake-week: cleared ${cleared} previous fake requests in this week`);
  }

  const rideTypes = await fetchRideTypes(admin);
  const destinations = await fetchDestinations(admin, dept);
  if (destinations.length === 0) {
    console.warn("fake-week: no approved destinations found — all requests will use free text");
  }

  const memberClients = await signInMembers(url, anonKey, members);

  // Deliberate collisions: a cluster of work-ride requests on the same day/time so the
  // solver has real conflicts to resolve (several members wanting the same slot).
  const collisionCount = Math.min(5, Math.max(2, Math.floor(args.count / 8)), members.length);
  const collisionDayIndex = 1; // Monday
  const collisionDepartMinutes = 7 * 60 + 30; // 07:30

  const plans = [];
  for (let i = 0; i < collisionCount; i++) {
    const requesterIndex = i % members.length;
    plans.push({
      requesterIndex,
      plan: buildRequestPlan(rng, {
        weekStart: week.week_start,
        rideTypes,
        destinations,
        members,
        requesterIndex,
        options: {
          allowShabbat: args.shabbat,
          forcedRideType: "work",
          forcedDayIndex: collisionDayIndex,
          forcedDepartMinutes: collisionDepartMinutes,
        },
      }),
    });
  }
  for (let i = collisionCount; i < args.count; i++) {
    const requesterIndex = randInt(rng, 0, members.length - 1);
    plans.push({
      requesterIndex,
      plan: buildRequestPlan(rng, {
        weekStart: week.week_start,
        rideTypes,
        destinations,
        members,
        requesterIndex,
        options: { allowShabbat: args.shabbat },
      }),
    });
  }

  const summary = {
    total: plans.length,
    succeeded: 0,
    failed: 0,
    byType: {},
    byDay: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"].reduce((acc, name) => {
      acc[name] = 0;
      return acc;
    }, {}),
    oneWayTo: 0,
    oneWayFrom: 0,
    relay: 0,
    passenger: 0,
    errors: [],
  };
  const DAY_NAMES = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

  for (const { requesterIndex, plan } of plans) {
    const client = memberClients[requesterIndex];
    const payload = { ...plan.payload, department_id: dept.id };

    const { data, error } = await client.rpc("submit_request", { payload });

    summary.byType[plan.rideTypeCode] = (summary.byType[plan.rideTypeCode] ?? 0) + 1;
    summary.byDay[DAY_NAMES[plan.dayIndex]] += 1;
    if (plan.tripShape === "one_way_to") summary.oneWayTo += 1;
    if (plan.tripShape === "one_way_from") summary.oneWayFrom += 1;
    if (payload.one_way_car_mode === "relay") summary.relay += 1;
    if (payload.one_way_car_mode === "passenger") summary.passenger += 1;

    if (error) {
      summary.failed += 1;
      summary.errors.push({ member: members[requesterIndex].email, error: error.message, payload });
      continue;
    }
    summary.succeeded += 1;

    if (plan.companionIndex !== null) {
      const requestId = data?.request_id;
      if (requestId) {
        await client.from("request_companions").insert({
          request_id: requestId,
          profile_id: members[plan.companionIndex].id,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n=== fake-week summary ===");
  console.log(`members:       ${members.length} (${createdCount} created, ${members.length - createdCount} reused)`);
  console.log(`requests:      ${summary.succeeded} succeeded / ${summary.failed} failed (of ${summary.total})`);
  console.log("by ride type:");
  for (const [code] of RIDE_TYPE_WEIGHTS) {
    console.log(`  ${code.padEnd(10)} ${summary.byType[code] ?? 0}`);
  }
  console.log("by day:");
  for (const name of DAY_NAMES) {
    if (summary.byDay[name] > 0) console.log(`  ${name.padEnd(8)} ${summary.byDay[name]}`);
  }
  console.log(`one-way-to (relay/passenger split): ${summary.oneWayTo} (${summary.relay} relay + ${summary.passenger} passenger, combined across both one-way shapes)`);
  console.log(`one-way-from:                       ${summary.oneWayFrom}`);

  if (summary.errors.length > 0) {
    console.log("\nerrors:");
    for (const e of summary.errors) {
      console.log(`  [${e.member}] ${e.error}`);
      console.log(`    payload: ${JSON.stringify(e.payload)}`);
    }
  }

  const failureRate = summary.total > 0 ? summary.failed / summary.total : 0;
  if (failureRate > 0.1) {
    console.error(`\nfake-week: failure rate ${(failureRate * 100).toFixed(1)}% exceeds 10% threshold`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`fake-week: ${err.message}`);
  process.exit(1);
});
