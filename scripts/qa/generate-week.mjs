#!/usr/bin/env node
// QA week generator (docs/QA_SIMULATION.md section 1).
//
//   npm run qa:week -- --seed <n> --out <dir> [--api <url>] [--tag <name>]
//
// Deterministic from --seed (mulberry32). Creates a dedicated QA department on a DISPOSABLE
// Supabase stack (refuses 127.0.0.1:54321 - see qa-common.mjs), a QA Sadran, 30-40 members with
// known passwords, shared + private cars, the places list, parent pairs with children, and about
// three requests per member for the next open week - all filed AS THE MEMBER via submit_request /
// submit_series_request. Hebrew copy lives in qa-data.json (CLAUDE.md hard rule 3).
// Writes <out>/personas.json, <out>/world.json and <out>/summary.md.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_EMAIL, ADMIN_PASSWORD, MEMBER_PASSWORD, SOURCE_DEPARTMENT_ID,
  addDays, chance, jerusalemDate, mulberry32, nextWeekStart, parseArgs, pick, quarter, randInt,
  resolveApi, roadKm, roadMinutes, serviceClient, shuffle, signedInClient, toInstant, weightedPick,
} from "./qa-common.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const QA_DATA = JSON.parse(readFileSync(path.join(here, "qa-data.json"), "utf8"));

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FLEX = ["0", "15 min", "30 min", "1 hour", "2 hours"];

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

// ---------------------------------------------------------------------------
// Department, places, week, cars
// ---------------------------------------------------------------------------
async function createDepartment(api, svc, tag, log) {
  const admin = await signedInClient(api, ADMIN_EMAIL, ADMIN_PASSWORD);
  const slug = `qa-${tag}`;
  const existing = await svc.from("departments").select("id").eq("slug", slug).maybeSingle();
  if (existing.data) throw new Error(`qa: department "${slug}" already exists on this stack - reset it or pass another --tag`);
  const { data, error } = await admin.rpc("create_department", {
    p_name: `${QA_DATA.department.name} ${tag}`, p_slug: slug, p_source_department_id: SOURCE_DEPARTMENT_ID,
  });
  if (error) throw new Error(`qa: create_department failed: ${error.message}`);
  log(`department ${slug} (${data.id}) created via create_department + catalog initialisation`);
  return data;
}

async function installPlaces(svc, dept) {
  const home = QA_DATA.home;
  const { data: rows, error } = await svc.from("destinations").select("id").eq("department_id", dept.id).neq("id", dept.home_destination_id);
  if (error) throw error;
  if (rows.length) {
    const del = await svc.from("destinations").delete().in("id", rows.map((r) => r.id));
    if (del.error) throw del.error;
  }
  const upd = await svc.from("destinations").update({
    name: home.name, lat: home.lat, lng: home.lng, zone: home.zone, distance_km: 0, travel_minutes: 0, public_transport_score: null, aliases: [],
  }).eq("id", dept.home_destination_id);
  if (upd.error) throw upd.error;

  const places = [{ id: dept.home_destination_id, name: home.name, lat: home.lat, lng: home.lng, zone: "home", band: "home", km: 0, minutes: 0 }];
  const inserts = QA_DATA.places.map((p) => {
    const km = roadKm(home, p);
    return { department_id: dept.id, name: p.name, zone: p.zone, lat: p.lat, lng: p.lng, distance_km: km, travel_minutes: roadMinutes(km), public_transport_score: p.pt, is_approved: true };
  });
  const ins = await svc.from("destinations").insert(inserts).select("id, name");
  if (ins.error) throw ins.error;
  const idByName = new Map(ins.data.map((r) => [r.name, r.id]));
  for (const p of QA_DATA.places) {
    const km = roadKm(home, p);
    places.push({ id: idByName.get(p.name), name: p.name, lat: p.lat, lng: p.lng, zone: p.zone, band: p.band, km, minutes: roadMinutes(km) });
  }
  const maxDrop = places.find((p) => p.name === QA_DATA.dropOffMaxPlace);
  for (const p of places) p.dropOff = p.band === "near" && p.km <= maxDrop.km;
  return places;
}

async function openWeek(svc, dept, now) {
  const weekStart = nextWeekStart(now);
  const hour = 3600_000;
  const { error } = await svc.from("weeks").insert({
    department_id: dept.id, week_start: weekStart, phase: "open",
    open_at: new Date(now.getTime() - 24 * hour).toISOString(),
    close_at: new Date(now.getTime() + 72 * hour).toISOString(),
    publish_at: new Date(now.getTime() + 96 * hour).toISOString(),
  });
  if (error) throw new Error(`qa: could not open week ${weekStart}: ${error.message}`);
  return weekStart;
}

async function createSharedCars(svc, dept, places, rng, tag) {
  const count = randInt(rng, 9, 12);
  const templates = shuffle(rng, QA_DATA.cars).slice(0, count);
  const awayBase = places.find((p) => p.name === QA_DATA.awayBasePlace) ?? places[1];
  // The van-like car with the most seats stays at home; a plain car gets the non-home base.
  const baseIdx = templates.findIndex((t) => Math.max(...t.seats.map((s) => s.adults)) <= 5);
  const cars = [];
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i];
    const base = i === baseIdx ? awayBase : null;
    const { data, error } = await svc.from("cars").insert({
      department_id: dept.id, name: t.name, license_plate: `${t.plate}-${tag}`.slice(0, 20), type: "shared", status: "active",
      features: t.features, base_location_id: base ? base.id : null,
    }).select("id").single();
    if (error) throw new Error(`qa: car insert failed: ${error.message}`);
    const seats = await svc.from("car_seat_configs").insert(t.seats.map((s) => ({ car_id: data.id, ...s })));
    if (seats.error) throw seats.error;
    cars.push({ id: data.id, name: t.name, seats: t.seats, features: t.features, base: base ? base.name : null });
  }
  return cars;
}

// ---------------------------------------------------------------------------
// Members and personas
// ---------------------------------------------------------------------------
function buildMemberPlan(rng, memberCount) {
  const names = new Set();
  const nextName = (female, lastName) => {
    for (let tries = 0; tries < 200; tries++) {
      const first = pick(rng, female ? QA_DATA.firstNamesF : QA_DATA.firstNamesM);
      const full = `${first} ${lastName ?? pick(rng, QA_DATA.lastNames)}`;
      if (!names.has(full)) { names.add(full); return full; }
    }
    throw new Error("qa: ran out of unique names");
  };
  const members = [];
  const pairCount = randInt(rng, 5, 7);
  const pairs = [];
  for (let p = 0; p < pairCount; p++) {
    const last = pick(rng, QA_DATA.lastNames);
    const a = members.push({ name: nextName(false, last), tags: ["parent"], base: "parent" }) - 1;
    const b = members.push({ name: nextName(true, last), tags: ["parent", "parentPairPartner"], base: "parent" }) - 1;
    pairs.push([a, b]);
  }
  while (members.length < memberCount) {
    const base = weightedPick(rng, [["commuter", 4], ["workFromHome", 2.5], ["nightOuting", 2.5], ["general", 1]]);
    members.push({ name: nextName(chance(rng, 0.5)), tags: base === "general" ? [] : [base], base });
  }
  const free = () => members.map((m, i) => i).filter((i) => !members[i].tags.includes("parent"));
  const take = (n, pool) => shuffle(rng, pool).slice(0, n);
  const privateOwners = take(randInt(rng, 4, 6), free());
  for (const i of privateOwners) members[i].tags.push("privateCar");
  // At least one private-car owner lives in Haifa.
  const haifaOwner = privateOwners[0];
  members[haifaOwner].tags.push("livesElsewhere");
  members[haifaOwner].originName = QA_DATA.haifaPlace;
  const elsewherePool = free().filter((i) => !members[i].tags.includes("livesElsewhere"));
  for (const i of take(4, elsewherePool)) {
    members[i].tags.push("livesElsewhere");
    members[i].originName = pick(rng, QA_DATA.originPlaces);
  }
  const nonDriverPool = free().filter((i) => !members[i].tags.includes("privateCar"));
  for (const i of take(randInt(rng, 1, 2), nonDriverPool)) members[i].tags.push("doesNotDrive");
  for (const m of members) {
    if (chance(rng, 0.2)) m.tags.push("hatesChangingTimes");
    else if (chance(rng, 0.25)) m.tags.push("veryFlexible");
    if (chance(rng, 0.1)) m.tags.push("oftenCancels");
    if (chance(rng, 0.15)) m.tags.push("answersHalfTheTime");
    if (chance(rng, 0.08)) m.tags.push("needsBigCarButForgotToSay");
    m.negotiationTendency = weightedPick(rng, [[0.05, 5], [0.15, 3], [0.35, 2]]);
    if (m.negotiationTendency >= 0.35) m.tags.push("negotiator");
  }
  // Exactly three members edit a request after submitting it (drivers only).
  for (const i of take(3, free().filter((i) => !members[i].tags.includes("privateCar") && !members[i].tags.includes("doesNotDrive")))) {
    members[i].tags.push("editsAfterSubmit");
  }
  return { members, pairs };
}

async function createAccounts(svc, dept, members, tag, log) {
  const sadranAccount = { name: QA_DATA.sadranName, email: `sadran@${tag}.qa.local` };
  const all = [{ ...sadranAccount, role: "sadran" }, ...members.map((m, i) => ({ name: m.name, email: `m${String(i + 1).padStart(2, "0")}@${tag}.qa.local`, role: "member" }))];
  const ids = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i];
    const phone = `+97254${String(hash(`${tag}-${i}`) % 10_000_000).padStart(7, "0")}`;
    const invite = await svc.from("member_invites").upsert(
      { email: a.email, full_name: a.name, phone, department_id: dept.id, role: a.role, consumed_at: null }, { onConflict: "email" });
    if (invite.error) throw new Error(`qa: invite ${a.email}: ${invite.error.message}`);
    const created = await svc.auth.admin.createUser({ email: a.email, password: MEMBER_PASSWORD, email_confirm: true, user_metadata: { full_name: a.name } });
    if (created.error) throw new Error(`qa: createUser ${a.email}: ${created.error.message}`);
    ids.push(created.data.user.id);
  }
  log(`${all.length} accounts created (1 Sadran + ${members.length} members)`);
  return { sadran: { ...all[0], id: ids[0], password: MEMBER_PASSWORD }, memberAccounts: all.slice(1).map((a, i) => ({ ...a, id: ids[i + 1], password: MEMBER_PASSWORD })) };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------
class Ctx {
  constructor({ rng, dept, weekStart, places, rideTypes, cars }) {
    Object.assign(this, { rng, dept, weekStart, places, rideTypes, cars });
    this.home = places[0];
    this.byName = new Map(places.map((p) => [p.name, p]));
    this.near = places.filter((p) => p.band === "near");
    this.dropOff = places.filter((p) => p.dropOff);
    this.mid = places.filter((p) => p.band === "far");
    this.rare = places.filter((p) => p.band === "rare");
  }
  day(i) { return addDays(this.weekStart, i); }
  dayIndex(allowFri = true) {
    return weightedPick(this.rng, [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], ...(allowFri ? [[5, 0.35]] : [])]);
  }
}

/** Builds a submit_request payload. Dest/origin are place objects or {text}. */
function buildPayload(ctx, o) {
  const rng = ctx.rng;
  const isRound = o.tripType === "round_trip" || (o.tripType === "drop_off" && o.pickup);
  const payload = {
    department_id: ctx.dept.id, week_start: ctx.weekStart,
    ride_type_id: ctx.rideTypes[o.rideType],
    trip_type: o.tripType,
    trip_shape: isRound ? "round_trip" : "one_way_to",
    depart_at: toInstant(ctx.day(o.day), o.depart),
    adults: o.adults ?? 1, child_seats: o.childSeats ?? 0, boosters: o.boosters ?? 0,
    has_luggage: o.luggage ?? false,
    flex_depart_early: o.flex?.[0] ?? "0", flex_depart_late: o.flex?.[1] ?? "0",
    flex_return_early: o.flex?.[2] ?? "0", flex_return_late: o.flex?.[3] ?? "0",
    stops: [],
  };
  if (isRound) payload.return_at = toInstant(ctx.day(o.returnDay ?? o.day), o.ret);
  if (o.dest.text) payload.destination_text = o.dest.text; else payload.destination_id = o.dest.id;
  if (o.origin) {
    if (o.origin.text) payload.origin_text = o.origin.text; else if (o.origin.id !== o.defaultOriginId) payload.origin_id = o.origin.id;
  }
  if (o.notes) payload.notes = o.notes;
  if (o.preferredCarId) payload.preferred_car_id = o.preferredCarId;
  if (o.companionIds?.length) payload.companion_ids = o.companionIds;
  for (const s of o.stops ?? []) payload.stops.push(s.text ? { leg: s.leg, place_text: s.text } : { leg: s.leg, place_id: s.id });
  return payload;
}

function flexMix(rng, kind) {
  if (kind === "rigid") return ["0", "0", "0", "0"];
  if (kind === "flexible") return [pick(rng, FLEX.slice(2)), pick(rng, FLEX.slice(2)), pick(rng, FLEX.slice(2)), pick(rng, FLEX.slice(2))];
  return [pick(rng, FLEX), pick(rng, FLEX), pick(rng, FLEX), pick(rng, FLEX)];
}

function planMemberRequests(ctx, m, idx, state) {
  const { rng } = ctx;
  const plans = [];
  const flexKind = m.tags.includes("hatesChangingTimes") ? "rigid" : m.tags.includes("veryFlexible") ? "flexible" : "mixed";
  const nonDriver = m.tags.includes("doesNotDrive");
  const defOrigin = m.originName ? ctx.byName.get(m.originName) : ctx.home;
  const base = {
    defaultOriginId: m.originName ? defOrigin.id : ctx.home.id, origin: defOrigin,
  };
  const note = () => (chance(rng, 0.12) ? pick(rng, QA_DATA.notes) : undefined);
  const dest = (list) => (chance(rng, 0.06) ? { text: pick(rng, QA_DATA.freeTextDestinations) } : pick(rng, list.filter((p) => p.id !== defOrigin.id)));
  const push = (kind, o) => plans.push({ kind, o: { ...base, flex: flexMix(rng, flexKind), notes: note(), ...o } });
  const days = shuffle(rng, [0, 1, 2, 3, 4]);

  const dropOffReq = (rideType, depart, pickupRet) => {
    const d = pick(rng, ctx.dropOff.filter((p) => p.id !== defOrigin.id));
    const pickup = pickupRet != null;
    push("dropOff", { tripType: "drop_off", pickup, rideType, day: days.pop() ?? 1, depart, ret: pickupRet, dest: d });
  };

  const sevenAm = () => quarter(randInt(rng, 6 * 60 + 30, 8 * 60));
  const nonHome = m.originName != null;
  const commuteFrom = nonHome && chance(rng, 0.7);

  switch (m.base) {
    case "parent": {
      const d1 = days.pop(), d2 = days.pop();
      for (const d of [d1, d2]) {
        const dep = quarter(randInt(rng, 7 * 60 + 15, 8 * 60 + 15));
        const pickup = chance(rng, 0.5) ? quarter(randInt(rng, 12 * 60 + 45, 16 * 60 + 30)) : null;
        const dst = pick(rng, ctx.dropOff);
        push("kids", { tripType: "drop_off", pickup: pickup != null, rideType: "childcare", day: d, depart: dep, ret: pickup, dest: dst, withChildren: true });
      }
      const day3 = days.pop() ?? 3;
      const dep3 = quarter(randInt(rng, 9 * 60, 14 * 60));
      push("clinic", { tripType: "round_trip", rideType: "healthcare", day: day3, depart: dep3, ret: dep3 + 60 * randInt(rng, 2, 4), dest: pick(rng, [...ctx.mid, ...ctx.near]), withChildren: chance(rng, 0.6), companionPartner: chance(rng, 0.5), adults: 2 });
      break;
    }
    case "commuter": {
      const dst = pick(rng, ctx.mid);
      const dep = sevenAm();
      const ret = quarter(randInt(rng, 15 * 60 + 30, 18 * 60 + 30));
      const n = nonDriver ? 0 : 3;
      for (let i = 0; i < Math.min(2, n); i++) {
        if (commuteFrom) push("commute", { tripType: "round_trip", rideType: "work", day: days.pop(), depart: dep, ret, dest: ctx.home, origin: defOrigin });
        else push("commute", { tripType: "round_trip", rideType: "work", day: days.pop(), depart: dep, ret, dest: dst });
      }
      if (nonDriver) for (let i = 0; i < 3; i++) dropOffReq("work", dep, ret > dep && chance(rng, 0.5) ? ret : null);
      else push("errand", { tripType: "round_trip", rideType: "errands", day: days.pop(), depart: quarter(randInt(rng, 10 * 60, 14 * 60)), ret: quarter(randInt(rng, 15 * 60, 16 * 60 + 30)), dest: dest([...ctx.near, ...ctx.mid]) });
      break;
    }
    case "workFromHome": {
      const kinds = shuffle(rng, ["errands", "healthcare", "other"]);
      for (let i = 0; i < 2; i++) {
        const dep = quarter(randInt(rng, 9 * 60, 13 * 60));
        if (nonDriver) dropOffReq(kinds[i], dep, chance(rng, 0.5) ? dep + 60 * randInt(rng, 1, 3) : null);
        else push("errand", { tripType: "round_trip", rideType: kinds[i], day: days.pop(), depart: dep, ret: dep + 60 * randInt(rng, 1, 3), dest: dest([...ctx.near, ...ctx.mid]) });
      }
      break;
    }
    case "nightOuting": {
      for (let i = 0; i < 2; i++) {
        const dep = quarter(randInt(rng, 17 * 60 + 30, 20 * 60 + 30));
        const ret = quarter(randInt(rng, 22 * 60 + 30, 23 * 60 + 45));
        if (nonDriver) dropOffReq("other", dep, null);
        else push("night", { tripType: "round_trip", rideType: "other", day: days.pop(), depart: dep, ret, dest: pick(rng, ctx.mid.filter((p) => QA_DATA.nightPlaces.includes(p.name))) });
      }
      break;
    }
    default: {
      for (let i = 0; i < 2; i++) {
        const dep = quarter(randInt(rng, 7 * 60, 17 * 60));
        if (nonDriver) dropOffReq("errands", dep, null);
        else push("errand", { tripType: "round_trip", rideType: pick(rng, ["errands", "work", "other"]), day: days.pop(), depart: dep, ret: dep + 60 * randInt(rng, 1, 4), dest: dest([...ctx.near, ...ctx.mid]) });
      }
    }
  }
  // Fill up to three requests with an extra mixed request.
  if (plans.length < 3) {
    const dep = quarter(randInt(rng, 8 * 60, 16 * 60));
    if (nonDriver || (chance(rng, 0.25) && ctx.dropOff.length)) dropOffReq(pick(rng, ["errands", "other"]), dep, chance(rng, 0.4) ? dep + 90 : null);
    else push("errand", { tripType: "round_trip", rideType: pick(rng, ["errands", "other", "healthcare"]), day: days.pop() ?? ctx.dayIndex(), depart: dep, ret: dep + 60 * randInt(rng, 1, 5), dest: dest([...ctx.near, ...ctx.mid]) });
  }
  // People living elsewhere: some trips are a round trip from their own town to the kibbutz.
  if (nonHome && !nonDriver) {
    for (const p of plans) if (p.kind === "errand" && chance(rng, 0.5)) {
      p.kind = "visitKibbutz"; p.o.dest = ctx.home; p.o.origin = defOrigin;
    }
  }
  return plans;
}

// ---------------------------------------------------------------------------
// Main generation
// ---------------------------------------------------------------------------
export async function generateWeek({ seed, out, apiUrl, tag, log = console.log, now = new Date() }) {
  const api = resolveApi(apiUrl);
  const svc = serviceClient(api);
  const rng = mulberry32(seed);
  tag = tag || `s${seed}`;
  mkdirSync(out, { recursive: true });

  log(`qa-week: seed ${seed}, tag ${tag}, api ${api.url}`);
  const dept = await createDepartment(api, svc, tag, log);
  const places = await installPlaces(svc, dept);
  const weekStart = await openWeek(svc, dept, now);
  log(`week ${weekStart} open`);
  const rt = await svc.from("ride_types").select("id, code").eq("department_id", dept.id);
  if (rt.error) throw rt.error;
  const rideTypes = Object.fromEntries(rt.data.map((r) => [r.code, r.id]));

  const cars = await createSharedCars(svc, dept, places, rng, tag);
  const ctx = new Ctx({ rng, dept, weekStart, places, rideTypes, cars });

  const memberCount = randInt(rng, 30, 40);
  const { members, pairs } = buildMemberPlan(rng, memberCount);
  const { sadran, memberAccounts } = await createAccounts(svc, dept, members, tag, log);
  members.forEach((m, i) => Object.assign(m, memberAccounts[i], { index: i + 1 }));

  // Profiles: non-drivers.
  for (const m of members.filter((x) => x.tags.includes("doesNotDrive"))) {
    const r = await svc.from("profiles").update({ does_not_drive: true }).eq("id", m.id);
    if (r.error) throw r.error;
  }
  // Children and guardians.
  const year = Number(jerusalemDate(now).slice(0, 4));
  const usedChildNames = new Set();
  for (const [a, b] of pairs) {
    const kids = randInt(rng, 1, 2);
    members[a].children = []; members[b].children = [];
    members[a].partnerIndex = members[b].index; members[b].partnerIndex = members[a].index;
    for (let k = 0; k < kids; k++) {
      let name;
      do name = `${pick(rng, QA_DATA.childNames)} ${members[a].name.split(" ").slice(1).join(" ")}`; while (usedChildNames.has(name));
      usedChildNames.add(name);
      const age = randInt(rng, 2, 11);
      const ins = await svc.from("children").insert({ department_id: dept.id, full_name: name, birth_year: year - age }).select("id").single();
      if (ins.error) throw ins.error;
      const g = await svc.from("child_guardians").insert([{ child_id: ins.data.id, profile_id: members[a].id }, { child_id: ins.data.id, profile_id: members[b].id }]);
      if (g.error) throw g.error;
      for (const m of [members[a], members[b]]) m.children.push({ id: ins.data.id, name, age });
    }
  }
  // Sign in each member, set default origins, register private cars.
  for (const m of members) m.client = await signedInClient(api, m.email, MEMBER_PASSWORD);
  for (const m of members) {
    if (!m.originName) continue;
    const place = ctx.byName.get(m.originName);
    const r = await m.client.rpc("set_my_default_origin", { p_department_id: dept.id, p_origin_id: place.id });
    if (r.error) throw new Error(`set_my_default_origin ${m.email}: ${r.error.message}`);
  }
  for (const m of members.filter((x) => x.tags.includes("privateCar"))) {
    const seats = pick(rng, [{ adults: 5, child_seats: 0, boosters: 0 }, { adults: 4, child_seats: 1, boosters: 0 }, { adults: 5, child_seats: 0, boosters: 1 }]);
    const name = `${pick(rng, QA_DATA.privateCarNames)}${m.name.split(" ")[0]}`;
    const car = await svc.from("cars").insert({ department_id: dept.id, name, license_plate: `QAP-${m.index}-${tag}`.slice(0, 20), type: "temporary", status: "active", owner_id: m.id }).select("id").single();
    if (car.error) throw new Error(`temporary car: ${car.error.message}`);
    const sc = await svc.from("car_seat_configs").insert({ car_id: car.data.id, ...seats });
    if (sc.error) throw sc.error;
    m.privateCar = { id: car.data.id, name, seats, base: m.originName ?? ctx.home.name };
  }
  log("members, children, default origins, private cars ready");

  // ---- requests ----
  const plans = [];
  members.forEach((m, i) => {
    for (const p of planMemberRequests(ctx, m, i, {})) plans.push({ member: m, ...p });
  });
  // Chainable one-way pairs (A: home -> X, B: X -> home later), plus lone one-way legs.
  const drivers = shuffle(rng, members.filter((m) => !m.tags.includes("doesNotDrive") && !m.tags.includes("livesElsewhere") && !m.tags.includes("parent")));
  const farChain = ctx.mid.filter((p) => QA_DATA.chainPlaces.includes(p.name));
  let di = 0;
  const chainPairs = randInt(rng, 2, 3);
  for (let c = 0; c < chainPairs && di + 1 < drivers.length; c++) {
    const x = pick(rng, farChain), day = ctx.dayIndex(false), t = quarter(randInt(rng, 7 * 60, 10 * 60));
    const a = drivers[di++], b = drivers[di++];
    plans.push({ member: a, kind: "chainOut", o: { tripType: "one_way", rideType: "work", day, depart: t, dest: x, origin: ctx.home, defaultOriginId: ctx.home.id, flex: flexMix(rng, "mixed") } });
    plans.push({ member: b, kind: "chainBack", o: { tripType: "one_way", rideType: "work", day, depart: quarter(t + 60 * randInt(rng, 5, 8)), dest: ctx.home, origin: x, defaultOriginId: b.originName ? ctx.byName.get(b.originName).id : ctx.home.id, flex: flexMix(rng, "mixed") } });
  }
  for (let c = 0; c < 3 && di < drivers.length; c++) {
    const x = pick(rng, farChain), a = drivers[di++];
    const out = chance(rng, 0.5);
    plans.push({ member: a, kind: "loneOneWay", o: { tripType: "one_way", rideType: "other", day: ctx.dayIndex(false), depart: quarter(randInt(rng, 8 * 60, 18 * 60)), dest: out ? x : ctx.home, origin: out ? ctx.home : x, defaultOriginId: ctx.home.id, flex: flexMix(rng, "mixed") } });
  }
  // Private-car rides (placed on the owner's own car after filing).
  for (const m of members.filter((x) => x.privateCar)) {
    const n = randInt(rng, 1, 2);
    for (let i = 0; i < n; i++) {
      const dep = quarter(randInt(rng, 7 * 60, 17 * 60));
      const home = m.originName ? ctx.byName.get(m.originName) : ctx.home;
      const to = pick(rng, [...ctx.mid, ...ctx.near].filter((p) => p.id !== home.id));
      plans.push({ member: m, kind: "privateRide", o: { tripType: "round_trip", rideType: pick(rng, ["errands", "work", "other"]), day: ctx.dayIndex(), depart: dep, ret: dep + 60 * randInt(rng, 1, 4), dest: to, origin: home, defaultOriginId: home.id, flex: ["0", "0", "0", "0"], privateCar: true } });
    }
  }
  // Multi-day series (round trips only) for a few drivers.
  const seriesMembers = shuffle(rng, members.filter((m) => !m.tags.includes("doesNotDrive") && !m.privateCar && !m.originName)).slice(0, randInt(rng, 3, 5));
  for (const m of seriesMembers) {
    const d1 = randInt(rng, 0, 3), d2 = Math.min(5, d1 + randInt(rng, 1, 2));
    plans.push({ member: m, kind: "series", o: { tripType: "round_trip", rideType: "work", day: d1, returnDay: d2, depart: quarter(randInt(rng, 7 * 60, 9 * 60)), ret: quarter(randInt(rng, 15 * 60, 19 * 60)), dest: pick(rng, [...ctx.mid, ...(chance(rng, 0.3) ? ctx.rare : [])]), origin: ctx.home, defaultOriginId: ctx.home.id, flex: flexMix(rng, "mixed"), series: true } });
  }
  // Decorations: stops, companions, preferred cars, extra seats.
  const sharedCars = cars;
  for (const p of plans) {
    const o = p.o, m = p.member;
    if (o.series || o.privateCar) continue;
    if (!m.tags.includes("doesNotDrive") && chance(rng, 0.12)) o.preferredCarId = pick(rng, sharedCars).id;
    if (o.tripType === "round_trip" && chance(rng, 0.1)) o.luggage = true;
    if (o.tripType !== "drop_off" && chance(rng, 0.09)) {
      const via = pick(rng, ctx.near.concat(ctx.mid).filter((x) => x.id !== o.dest.id && x.id !== o.origin?.id));
      o.stops = [{ leg: "out", id: via.id }];
      if (o.tripType === "round_trip" && chance(rng, 0.3)) o.stops.push({ leg: "return", ...(chance(rng, 0.5) ? { text: pick(rng, QA_DATA.stopFreeText) } : { id: pick(rng, ctx.near).id }) });
    }
    if (p.kind === "kids" && m.children?.length) {
      o.stops = o.stops ?? [];
    }
    if (o.companionPartner && m.partnerIndex) o.companionIds = [members[m.partnerIndex - 1].id];
    else if (!m.tags.includes("parent") && o.tripType === "round_trip" && chance(rng, 0.08)) {
      const comp = pick(rng, members.filter((x) => x.index !== m.index && !x.tags.includes("doesNotDrive")));
      o.companionIds = [comp.id];
      o.adults = Math.max(o.adults ?? 1, 2);
    }
    if (o.companionIds?.length) o.adults = Math.max(o.adults ?? 1, 1 + o.companionIds.length);
    if (!o.companionIds && chance(rng, 0.12)) o.adults = weightedPick(rng, [[2, 6], [3, 3], [4, 1]]);
    // A non-driver may file a round trip only with a driving companion.
    if (m.tags.includes("doesNotDrive") && o.tripType !== "drop_off") { o.tripType = "drop_off"; o.pickup = true; }
  }

  // A person does not file two rides that overlap in time: move a clashing request to another day
  // (series and chained legs keep their day, so a clash drops them instead).
  const busy = new Map();
  const spanOf = (o) => {
    const start = (o.day * 1440) + o.depart;
    const isRound = o.tripType === "round_trip" || (o.tripType === "drop_off" && o.pickup);
    const end = isRound ? ((o.returnDay ?? o.day) * 1440) + o.ret : start + 120;
    return [start - 30, end + 30];
  };
  const clashes = (m, [a, b]) => (busy.get(m.id) ?? []).some(([c, d]) => a < d && c < b);
  const kept = [];
  // Fixed-day plans claim their time first; the movable ones work around them.
  const claimOrder = [...plans.filter((p) => p.kind === "series"), ...plans.filter((p) => ["chainOut", "chainBack", "loneOneWay"].includes(p.kind)), ...plans.filter((p) => !["series", "chainOut", "chainBack", "loneOneWay"].includes(p.kind))];
  for (const p of claimOrder) {
    const movable = !["series", "chainOut", "chainBack", "loneOneWay"].includes(p.kind);
    let ok = !clashes(p.member, spanOf(p.o));
    for (let tries = 0; !ok && movable && tries < 6; tries++) {
      p.o.day = ctx.dayIndex(false);
      ok = !clashes(p.member, spanOf(p.o));
    }
    if (!ok) continue;
    busy.set(p.member.id, [...(busy.get(p.member.id) ?? []), spanOf(p.o)]);
    kept.push(p);
  }
  plans.length = 0;
  plans.push(...kept);

  // ---- file everything as the member ----
  const submitted = [];
  const failures = [];
  const rtDuplicates = new Set();
  for (const p of plans) {
    const m = p.member;
    const payload = buildPayload(ctx, p.o);
    if (payload.destination_id && payload.destination_id === (payload.origin_id ?? (m.originName ? ctx.byName.get(m.originName).id : ctx.home.id))) {
      payload.destination_id = ctx.home.id === payload.destination_id ? ctx.near[0].id : ctx.home.id;
    }
    const fn = p.o.series ? "submit_series_request" : "submit_request";
    const key = `${m.id}|${payload.depart_at}|${payload.destination_id ?? payload.destination_text}`;
    if (rtDuplicates.has(key)) continue;
    rtDuplicates.add(key);
    const res = await m.client.rpc(fn, { payload });
    if (res.error) { failures.push({ member: m.email, kind: p.kind, error: res.error.message, payload }); continue; }
    const ids = fn === "submit_series_request" ? res.data.request_ids : [res.data.request_id];
    for (const id of ids) {
      const rec = { id, member: m, kind: p.kind, o: p.o, payload, series: !!p.o.series };
      submitted.push(rec);
      if (p.o.withChildren && m.children?.length) {
        const pickKids = m.children.slice(0, p.o.withChildren === true ? m.children.length : 1);
        const cr = await m.client.rpc("set_request_children", { p_request_id: id, p_child_ids: pickKids.map((k) => k.id) });
        if (cr.error) failures.push({ member: m.email, kind: `${p.kind}+children`, error: cr.error.message });
        else rec.children = pickKids.map((k) => k.name);
      }
    }
  }
  log(`${submitted.length} requests filed, ${failures.length} failed`);

  // Private-car rides placed on the owner's own car (the owner's rides appear on the board).
  let privatePlaced = 0;
  for (const rec of submitted.filter((r) => r.o.privateCar)) {
    const res = await svc.rpc("place_request_on_car", {
      p_request_id: rec.id, p_car_id: rec.member.privateCar.id, p_manual: false, p_actor: rec.member.id,
      p_named_driver: null, p_dep: null, p_ret: null, p_reason: "TEMP_CAR_OWNER",
    });
    if (res.error) failures.push({ member: rec.member.email, kind: "privateRidePlacement", error: res.error.message });
    else { privatePlaced++; rec.placedOnPrivateCar = true; }
  }

  // Edits after submission (a 30-minute shift), as the member.
  let edited = 0;
  for (const m of members.filter((x) => x.tags.includes("editsAfterSubmit"))) {
    const rec = submitted.find((r) => r.member === m && !r.series && !r.o.privateCar && r.payload.trip_shape === "round_trip");
    if (!rec) continue;
    const cur = await svc.from("requests").select("version, status").eq("id", rec.id).single();
    if (cur.error || cur.data.status !== "submitted") continue;
    const shift = 30 * 60_000;
    const payload = { ...rec.payload, request_id: rec.id, expected_version: cur.data.version,
      depart_at: new Date(Date.parse(rec.payload.depart_at) + shift).toISOString(),
      return_at: new Date(Date.parse(rec.payload.return_at) + shift).toISOString() };
    delete payload.companion_ids;
    const res = await m.client.rpc("submit_request", { payload });
    if (res.error) failures.push({ member: m.email, kind: "editAfterSubmit", error: res.error.message });
    else { edited++; rec.editedAfterSubmit = true; }
  }
  log(`${privatePlaced} private-car rides placed, ${edited} requests edited after submit`);

  // ---- planned live-phase events ----
  const liveEvents = planLiveEvents(ctx, members, submitted);

  // ---- outputs ----
  const personas = {
    seed, tag, department: { id: dept.id, slug: dept.slug }, weekStart,
    note: "QA user agent ONLY - the QA Sadran must never read this file (docs/QA_SIMULATION.md section 0).",
    personaTagGlossary: QA_DATA.personaTags, liveEventTypes: QA_DATA.liveEventTypes,
    negotiationLines: QA_DATA.negotiationLines,
    members: members.map((m) => ({
      index: m.index, id: m.id, name: m.name, email: m.email, password: m.password, tags: m.tags, baseArchetype: m.base,
      defaultOrigin: m.originName ?? null, doesNotDrive: m.tags.includes("doesNotDrive"),
      children: (m.children ?? []).map((c) => ({ id: c.id, name: c.name, age: c.age })),
      partner: m.partnerIndex ? members[m.partnerIndex - 1].name : null,
      privateCar: m.privateCar ?? null,
      negotiationTendency: m.negotiationTendency,
      requests: submitted.filter((r) => r.member === m).map((r) => ({
        id: r.id, kind: r.kind, tripType: r.payload.trip_type, series: r.series, departAt: r.payload.depart_at, returnAt: r.payload.return_at ?? null,
        destination: r.o.dest.text ?? places.find((p) => p.id === r.o.dest.id)?.name, preferredCar: r.o.preferredCarId ? cars.find((c) => c.id === r.o.preferredCarId)?.name : null,
        stops: (r.o.stops ?? []).length, children: r.children ?? [], placedOnPrivateCar: !!r.placedOnPrivateCar, editedAfterSubmit: !!r.editedAfterSubmit,
      })),
      liveEvents: liveEvents.filter((e) => e.memberIndex === m.index),
    })),
  };
  const world = {
    seed, tag, api: api.url, department: { id: dept.id, slug: dept.slug, name: dept.name, homePlaceId: dept.home_destination_id },
    weekStart, sadran: { id: sadran.id, email: sadran.email, password: sadran.password, name: sadran.name },
    places: places.map(({ id, name, zone, band, km, minutes, dropOff }) => ({ id, name, zone, band, km, minutes, dropOff })),
    cars, privateCars: members.filter((m) => m.privateCar).map((m) => ({ ...m.privateCar, owner: m.name })),
    requestCount: submitted.length, failures: failures.map(({ payload, ...f }) => f),
  };
  writeFileSync(path.join(out, "personas.json"), `${JSON.stringify(personas, null, 2)}\n`);
  writeFileSync(path.join(out, "world.json"), `${JSON.stringify(world, null, 2)}\n`);
  const summary = renderSummary({ world, members, submitted, places, liveEvents, failures, privatePlaced, edited, pairs, ctx });
  writeFileSync(path.join(out, "summary.md"), summary);
  const failureRate = plans.length ? failures.length / plans.length : 0;
  return { world, personas, summary, failures, failureRate, submittedCount: submitted.length };
}

function planLiveEvents(ctx, members, submitted) {
  const { rng } = ctx;
  const events = [];
  const mine = (m) => submitted.filter((r) => r.member === m && !r.series);
  for (const m of members.filter((x) => x.tags.includes("oftenCancels"))) {
    const rec = pick(rng, mine(m).length ? mine(m) : [null]);
    if (rec) events.push({ memberIndex: m.index, type: "cancelRequest", requestId: rec.id, when: "after publish" });
  }
  for (const m of members.filter((x) => x.tags.includes("editsAfterSubmit"))) {
    const rec = mine(m).find((r) => r.payload.trip_shape === "round_trip");
    if (rec) events.push({ memberIndex: m.index, type: "editRequest", requestId: rec.id, shiftMinutes: 30, when: "after publish" });
  }
  const lateOnes = shuffle(rng, members.filter((x) => !x.tags.includes("doesNotDrive") && !x.privateCar)).slice(0, 4);
  for (const m of lateOnes) {
    const dep = quarter(randInt(rng, 8 * 60, 17 * 60));
    events.push({ memberIndex: m.index, type: "lateRequest", day: DAY_NAMES[ctx.dayIndex(false)], departMinutes: dep, returnMinutes: dep + 60 * randInt(rng, 1, 4), destination: pick(rng, ctx.mid).name, when: "after publish" });
  }
  for (const m of shuffle(rng, members.filter((x) => !x.tags.includes("doesNotDrive"))).slice(0, 2)) {
    events.push({ memberIndex: m.index, type: "carNow", destination: pick(rng, ctx.near).name, when: "live phase" });
  }
  for (const m of shuffle(rng, members).slice(0, 2)) events.push({ memberIndex: m.index, type: "askToJoin", note: "pick any published ride to a place you are going to", when: "after publish" });
  return events;
}

function renderSummary({ world, members, submitted, places, liveEvents, failures, privatePlaced, edited, pairs, ctx }) {
  const L = [];
  L.push(`# QA week summary - seed ${world.seed}, week ${world.weekStart}`);
  L.push("", `Department \`${world.department.slug}\`, QA Sadran \`${world.sadran.email}\`, ${members.length} members, ${world.cars.length} shared + ${world.privateCars.length} private cars, home ${QA_DATA.home.name}.`);
  const tagCount = {};
  for (const m of members) for (const t of m.tags) tagCount[t] = (tagCount[t] ?? 0) + 1;
  L.push("", "## Members by persona", Object.entries(tagCount).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(" | "), `(parent pairs: ${pairs.length}; non-drivers: ${members.filter((m) => m.tags.includes("doesNotDrive")).map((m) => m.name).join(", ")}; living elsewhere: ${members.filter((m) => m.originName).map((m) => `${m.name} (${m.originName})`).join(", ")})`);
  const count = (fn) => { const o = {}; for (const r of submitted) { const k = fn(r); o[k] = (o[k] ?? 0) + 1; } return o; };
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" | ");
  L.push("", `## Requests (${submitted.length} filed, ${failures.length} failed to file)`);
  L.push(`By trip type: ${fmt(count((r) => (r.series ? "multi-day" : r.payload.trip_type) + (r.payload.trip_type === "drop_off" ? (r.payload.return_at ? " (+pickup)" : " (no pickup)") : "")))}`);
  const dayOf = (r) => DAY_NAMES[r.o.day];
  L.push(`By day: ${fmt(count(dayOf))}`);
  const band = (r) => (r.o.dest.text ? "free text" : places.find((p) => p.id === r.o.dest.id)?.band ?? "?");
  L.push(`By destination band: ${fmt(count(band))}`);
  L.push(`By kind: ${fmt(count((r) => r.kind))}`);
  L.push(`Extras: multi-stop ${submitted.filter((r) => (r.o.stops ?? []).length).length}, with companions ${submitted.filter((r) => r.o.companionIds?.length).length}, with children ${submitted.filter((r) => r.children?.length).length}, preferred car ${submitted.filter((r) => r.o.preferredCarId).length}, private-car rides placed ${privatePlaced}, edited after submit ${edited}.`);
  const dropOffs = submitted.filter((r) => r.payload.trip_type === "drop_off");
  L.push(`Drop-off destinations: ${[...new Set(dropOffs.map((r) => places.find((p) => p.id === r.o.dest.id)?.name ?? "home"))].join(", ")} (all within ${QA_DATA.dropOffMaxPlace} distance).`);
  L.push("", "## Cars");
  for (const c of world.cars) L.push(`- ${c.name}: ${c.seats.map((s) => `${s.adults}a${s.child_seats ? `+${s.child_seats}cs` : ""}${s.boosters ? `+${s.boosters}bo` : ""}`).join(" / ")}${c.base ? ` (base ${c.base})` : ""}${c.features.length ? ` [${c.features.join(",")}]` : ""}`);
  for (const c of world.privateCars) L.push(`- private: ${c.name} (owner ${c.owner}, base ${c.base})`);
  L.push("", `Live-phase events planned: ${liveEvents.length} (${fmt(Object.fromEntries(Object.entries(liveEvents.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {}))))}).`);
  if (failures.length) { L.push("", "## Filing failures"); for (const f of failures.slice(0, 15)) L.push(`- ${f.member} ${f.kind}: ${f.error}`); }
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2), { seed: "7", out: "", api: "", tag: "" });
  if (!args.out) { console.error("usage: npm run qa:week -- --seed <n> --out <dir> [--api <url>] [--tag <name>]"); process.exit(2); }
  generateWeek({ seed: Number(args.seed), out: path.resolve(args.out), apiUrl: args.api, tag: args.tag })
    .then((r) => {
      console.log(`\n${r.summary}`);
      if (r.failureRate > 0.1) { console.error(`qa-week: ${(r.failureRate * 100).toFixed(1)}% of requests failed to file (>10%)`); process.exit(1); }
    })
    .catch((e) => { console.error(`qa-week: ${e.message}`); process.exit(1); });
}
