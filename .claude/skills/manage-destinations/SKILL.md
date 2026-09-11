---
name: manage-destinations
description: Add or edit destinations (name, aliases, zone, distance, travel time, public-transport score) via seed or admin UI, or approve a member-suggested free-text destination. Use when asked to "add a destination", "add destination preset", "add Tel Aviv / Afula / the clinic to the list", "change a destination's zone or distance", "fix the destinations list", "seed destinations".
---

# Manage destinations

Destinations are **data**, not code (DATA_MODEL §3.3 `destinations`, REQ §13.8). Two paths:

- **Production**: Admin → Destinations in the app. No code change.
- **Local dev / e2e / first rollout**: `supabase/seed.sql` destinations block (~15 rows).

## Table (DATA_MODEL §3.3)
`destinations`: `name` (unique, normalized by trigger), `aliases text[]` (GIN, typeahead), `zone text` default `'unknown'` (free vocabulary managed by admins: `north`, `haifa`, `tel_aviv`, …), `lat/lng`, `distance_km`, `travel_minutes`, `public_transport_score smallint 0..5` (5 = excellent → lower priority), `is_approved bool` (false = suggested from free text), `created_by`.

Solver mapping (`src/features/solverBridge/buildSolverInput.ts`): `publicTransportScore = score / 5` (solver uses 0..1), `zone` passed through; `'unknown'` never merges (SOLVER.md §3.8).

## A. Add or change destinations in the seed
- [ ] Edit the destinations block in `supabase/seed.sql`: `insert into public.destinations (id, name, aliases, zone, distance_km, travel_minutes, public_transport_score, is_approved) values (...) on conflict (name) do update set ...;` Keep alphabetical by Hebrew name; fixed UUIDs for rows referenced by `e2e/helpers.ts` (there is no `e2e/fixtures/` folder anymore).
- [ ] Zone is free text but keep the vocabulary consistent: `grep -o "'[a-z_]*'" supabase/seed.sql` for existing zones before inventing one. Zone equality drives merge detection, so two names for one area silently break merges.
- [ ] `npm run db:reset`; open Admin → Destinations and eyeball the list.
- [ ] `docs/DATA_MODEL.md` §3.3: update only if the column semantics or zone vocabulary changed (not per row). If you added a zone, list it in DATA_MODEL §3.3 and UX_FLOWS §5.6 Destinations.

## B. Approve a member-suggested (free-text) destination
- In the app: members' free text calls `suggest_destination()` RPC → row with `is_approved = false`; Admin → Destinations → "Suggested" tab → set zone/distance/travel/PT score → approve; matching `requests.destination_id` are back-filled.
- Code only if that UI is missing: `src/features/admin/destinations/components/ApproveDestinationDialog.tsx`, RPC `approve_destination(id, zone, distance_km, travel_minutes, pt_score)` (admin only), `docs/UX_FLOWS.md` §5.6 Destinations.

## C. Change how destinations affect priority
- That is a rule or a weight, not data: `distance` and `publicTransport` rule types (SOLVER.md §4.3) read `distanceKm` / `publicTransportScore`. Change weights in Admin → Policies; change the curve via `/add-priority-rule` (edit the rule file + SOLVER.md §4.3).

## Final verification
- [ ] `npm run db:reset` passes; `select name, count(*) from destinations group by 1 having count(*) > 1` is empty.
- [ ] Every seeded destination has `is_approved = true` and a zone other than `unknown` unless intentionally unclassified.
- [ ] `npm run typecheck && npm run test` pass (only relevant if TS changed).
- [ ] Docs updated only if vocabulary/semantics changed.
