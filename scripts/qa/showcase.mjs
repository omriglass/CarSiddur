#!/usr/bin/env node
// Showcase department (docs/SHOWCASE_SCENARIOS.md): a small, fixed department where every member,
// car and request demonstrates one principle - for hands-on testing and as a checklist reference.
// Same building blocks as `qa:week` (scripts/qa/generate-week.mjs); data in showcase-data.json.
//
// Usage: npm run qa:showcase -- --out <dir> [--api <url>] [--tag showcase] [--this-week]
// The owner's own stack (127.0.0.1:54321) needs QA_OWNER_STACK=1 (qa-common.mjs).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_EMAIL, ADMIN_PASSWORD, MEMBER_PASSWORD, SOURCE_DEPARTMENT_ID,
  addDays, mulberry32, parseArgs, resolveApi, serviceClient, signedInClient, toInstant,
} from "./qa-common.mjs";
import { Ctx, buildPayload, createAccounts, installPlaces, openWeek } from "./generate-week.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(readFileSync(path.join(here, "showcase-data.json"), "utf8"));

const hhmm = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

async function createDepartment(api, svc, tag, log) {
  const admin = await signedInClient(api, ADMIN_EMAIL, ADMIN_PASSWORD);
  const slug = `qa-${tag}`;
  const existing = await svc.from("departments").select("id").eq("slug", slug).maybeSingle();
  if (existing.data) throw new Error(`showcase: department "${slug}" already exists on this stack - pass another --tag`);
  const { data, error } = await admin.rpc("create_department", {
    // Department names are unique: the default tag gets the plain name, any other tag is appended.
    p_name: tag === "showcase" ? DATA.department.name : `${DATA.department.name} ${tag}`, p_slug: slug, p_source_department_id: SOURCE_DEPARTMENT_ID,
  });
  if (error) throw new Error(`create_department failed: ${error.message}`);
  log(`department ${slug} (${data.id}) created`);
  return data;
}

export async function buildShowcase({ out, apiUrl, tag = "showcase", log = console.log, now = new Date(), thisWeek = false }) {
  const api = resolveApi(apiUrl);
  const svc = serviceClient(api);
  const dept = await createDepartment(api, svc, tag, log);
  const places = await installPlaces(svc, dept);
  const byName = new Map(places.map((p) => [p.name, p]));
  const place = (name) => { const p = byName.get(name); if (!p) throw new Error(`showcase: unknown place ${name}`); return p; };
  const weekStart = await openWeek(svc, dept, now, thisWeek);
  const rt = await svc.from("ride_types").select("id, code").eq("department_id", dept.id);
  if (rt.error) throw rt.error;
  const rideTypes = Object.fromEntries(rt.data.map((r) => [r.code, r.id]));

  // ---- shared cars ----
  const cars = [];
  for (const c of DATA.cars) {
    const base = c.base ? place(c.base) : null;
    const { data, error } = await svc.from("cars").insert({
      department_id: dept.id, name: c.name, license_plate: `${c.plate}-${tag}`.slice(0, 20), type: "shared", status: "active",
      features: c.features, base_location_id: base ? base.id : null,
    }).select("id").single();
    if (error) throw new Error(`showcase: car ${c.key}: ${error.message}`);
    const seats = await svc.from("car_seat_configs").insert(c.seats.map((s) => ({ car_id: data.id, ...s })));
    if (seats.error) throw seats.error;
    cars.push({ key: c.key, id: data.id, name: c.name, seats: c.seats, features: c.features, base: base ? base.name : null });
  }

  // ---- accounts (Sadran + members, in data order: m01..m08) ----
  const { sadran, memberAccounts } = await createAccounts(svc, dept, DATA.members.map((m) => ({ name: m.name })), tag, log);
  const members = DATA.members.map((m, i) => ({ ...m, ...memberAccounts[i] }));
  const memberByKey = new Map(members.map((m) => [m.key, m]));
  for (const m of members) m.client = await signedInClient(api, m.email, MEMBER_PASSWORD);
  for (const m of members.filter((x) => x.doesNotDrive)) {
    const r = await svc.from("profiles").update({ does_not_drive: true }).eq("id", m.id);
    if (r.error) throw r.error;
  }
  for (const m of members.filter((x) => x.origin)) {
    const r = await m.client.rpc("set_my_default_origin", { p_department_id: dept.id, p_origin_id: place(m.origin).id });
    if (r.error) throw new Error(`set_my_default_origin ${m.email}: ${r.error.message}`);
    m.defaultOriginId = place(m.origin).id;
  }
  const year = Number(weekStart.slice(0, 4));
  for (const child of DATA.children) {
    const ins = await svc.from("children").insert({ department_id: dept.id, full_name: child.name, birth_year: year - child.age }).select("id").single();
    if (ins.error) throw ins.error;
    const g = await svc.from("child_guardians").insert(child.guardians.map((k) => ({ child_id: ins.data.id, profile_id: memberByKey.get(k).id })));
    if (g.error) throw g.error;
    for (const k of child.guardians) (memberByKey.get(k).children ??= []).push({ id: ins.data.id, name: child.name });
  }
  for (const m of members.filter((x) => x.privateCar)) {
    const pc = m.privateCar;
    const car = await svc.from("cars").insert({ department_id: dept.id, name: pc.name, license_plate: `${pc.plate}-${tag}`.slice(0, 20), type: "temporary", status: "active", owner_id: m.id }).select("id").single();
    if (car.error) throw new Error(`private car: ${car.error.message}`);
    const sc = await svc.from("car_seat_configs").insert({ car_id: car.data.id, ...pc.seats });
    if (sc.error) throw sc.error;
    m.privateCarRow = { id: car.data.id, name: pc.name, seats: [pc.seats], base: places[0].name, owner: m.name };
  }

  // ---- maintenance blocks ----
  for (const b of DATA.maintenance) {
    const car = cars.find((c) => c.key === b.car);
    const day = addDays(weekStart, b.day);
    const r = await svc.from("car_maintenance_blocks").insert({
      car_id: car.id, department_id: dept.id, starts_at: toInstant(day, hhmm(b.from)), ends_at: toInstant(day, hhmm(b.to)), reason: b.reason, created_by: sadran.id,
    });
    if (r.error) throw new Error(`maintenance: ${r.error.message}`);
  }
  log("cars, members, children, default origins, private car and maintenance ready");

  // ---- requests, filed as the member through the real RPCs ----
  const ctx = new Ctx({ rng: mulberry32(1), dept, weekStart, places, rideTypes, cars });
  const filed = new Map();
  const results = [];
  for (const s of DATA.requests) {
    const m = memberByKey.get(s.member);
    const dest = typeof s.dest === "object" ? { text: s.dest.text === "@freeText" ? DATA.freeText : s.dest.text } : place(s.dest);
    const origin = !s.origin || s.origin === "@default" ? undefined : place(s.origin);
    const o = {
      tripType: s.trip, pickup: s.pickup, rideType: s.rideType, day: s.day, returnDay: s.returnDay,
      depart: hhmm(s.depart), ret: s.ret ? hhmm(s.ret) : undefined, dest, origin,
      defaultOriginId: m.defaultOriginId ?? places[0].id, flex: s.flex, adults: s.adults, luggage: s.luggage, notes: s.notes,
      stops: (s.stops ?? []).map((st) => ({ leg: st.leg, id: place(st.place).id })),
    };
    const payload = buildPayload(ctx, o);
    if (s.joinOf) {
      const host = filed.get(s.joinOf);
      const rr = host ? await svc.from("ride_requests").select("ride_id").eq("request_id", host.requestId).limit(1).maybeSingle() : null;
      if (rr?.data?.ride_id) payload.join_ride_id = rr.data.ride_id;
    }
    const fn = s.series ? "submit_series_request" : "submit_request";
    const res = await m.client.rpc(fn, { payload });
    if (res.error) { results.push({ id: s.id, member: m.email, error: res.error.message }); continue; }
    const requestIds = s.series ? res.data.request_ids : [res.data.request_id];
    filed.set(s.id, { requestId: requestIds[0], requestIds });
    if (s.children === "all" && m.children?.length) {
      for (const id of requestIds) {
        const cr = await m.client.rpc("set_request_children", { p_request_id: id, p_child_ids: m.children.map((k) => k.id) });
        if (cr.error) results.push({ id: `${s.id}+children`, member: m.email, error: cr.error.message });
      }
    }
    if (s.privateCar && m.privateCarRow) {
      const pr = await svc.rpc("place_request_on_car", {
        p_request_id: requestIds[0], p_car_id: m.privateCarRow.id, p_manual: false, p_actor: m.id,
        p_named_driver: null, p_dep: null, p_ret: null, p_reason: "TEMP_CAR_OWNER",
      });
      if (pr.error) results.push({ id: `${s.id}+privateCar`, member: m.email, error: pr.error.message });
    }
    results.push({ id: s.id, member: m.email, requestIds });
  }
  const failures = results.filter((r) => r.error);
  log(`${results.length - failures.length} showcase requests filed, ${failures.length} problems`);

  // ---- outputs: world.json (read by qa:sadran / qa:member) + scenario map ----
  mkdirSync(out, { recursive: true });
  const world = {
    seed: 0, tag, api: api.url, department: { id: dept.id, slug: dept.slug, name: dept.name, homePlaceId: dept.home_destination_id },
    weekStart, sadran: { id: sadran.id, email: sadran.email, password: sadran.password, name: sadran.name },
    places: places.map(({ id, name, zone, band, km, minutes, dropOff }) => ({ id, name, zone, band, km, minutes, dropOff })),
    cars, privateCars: members.filter((m) => m.privateCarRow).map((m) => m.privateCarRow),
    requestCount: results.length - failures.length, failures,
  };
  writeFileSync(path.join(out, "world.json"), `${JSON.stringify(world, null, 2)}\n`);
  const scenarios = DATA.requests.map((s) => ({ id: s.id, member: memberByKey.get(s.member).email, requestIds: filed.get(s.id)?.requestIds ?? [] }));
  writeFileSync(path.join(out, "scenarios.json"), `${JSON.stringify({ members: members.map(({ key, name, email, about }) => ({ key, name, email, about })), scenarios }, null, 2)}\n`);
  return { world, failures, members };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2), { out: "", api: "", tag: "showcase", "this-week": false });
  if (!args.out) { console.error("usage: npm run qa:showcase -- --out <dir> [--api <url>] [--tag showcase] [--this-week]"); process.exit(2); }
  buildShowcase({ out: path.resolve(args.out), apiUrl: args.api, tag: args.tag, thisWeek: args["this-week"] === true })
    .then((r) => {
      console.log(`week ${r.world.weekStart}, department ${r.world.department.slug}; Sadran ${r.world.sadran.email}; password ${MEMBER_PASSWORD}`);
      for (const m of r.members) console.log(`  ${m.email}  ${m.about}`);
      for (const f of r.failures) console.log(`  PROBLEM ${f.id} (${f.member}): ${f.error}`);
      if (r.failures.length) process.exit(1);
    })
    .catch((e) => { console.error(`showcase: ${e.message}`); process.exit(1); });
}
