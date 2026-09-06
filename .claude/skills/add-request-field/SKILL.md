---
name: add-request-field
description: Add a new field to ride requests end to end (requests + request_templates columns, views, types, zod schema, request form, Hebrew labels, solver input mapping, board/request card display, tests, docs). Use when asked to "add a field to the request", "let members specify X when requesting", "add a checkbox/option to the ride request form", "the request should also record Y".
---

# Add a field to ride requests

Tables: `requests` (DATA_MODEL §3.6) and its mirror `request_templates` (repeat-weekly). Read-only views `v_my_requests`, `v_board_rides` (DATA_MODEL §6 step 18, `20260907091700_views.sql`) expose request columns to the UI. Requests are written **only** through the `submit_request(payload jsonb)` RPC — there is no direct INSERT/UPDATE policy, so every new column must be mapped in that function. Paths are the documented layout — fix here if the repo differs.

## Inputs to collect before starting

- Column name (snake_case), SQL type, nullable?, default. Prefer `not null default …` for booleans/enums.
- Enum? Name + values (`/add-migration` rules) — e.g. `requests.trip_shape` (`round_trip | one_way_to | one_way_from`) and `requests.one_way_car_mode` (`relay | passenger`, required only when `trip_shape <> 'round_trip'`) are the reference example of an enum-backed request field with a conditional-required rule.
- Who sets it: member (form), Sadran only (board drawer), or both. Which week phases allow editing it.
- Does the solver use it (feasibility, merge, a rule)? Does changing it after solving count as "solve-relevant" (sets `changed_since_solve`)?
- Where it shows: request form, my-requests card, board request drawer, ride tooltip, WhatsApp proposal text, siddur view.
- Hebrew label, help text, per-value labels.

## Steps

### 1. Migration (`supabase/migrations/YYYYMMDDHHMMSS_add_<field>_to_requests.sql`)
- [ ] `alter table public.requests add column <field> <type> [not null default …];`
- [ ] Same column on `public.request_templates` (templates materialize into requests).
- [ ] Enum: `create type <enum> as enum (...)` earlier in the same file is fine (new type); adding a *value* to an existing type goes in its own file.
- [ ] `create or replace function public.submit_request(payload jsonb)`: map `payload->><field>` to the column on insert and edit; if solve-relevant, add the column to its "changed while `weeks.phase <> 'open'` ⇒ `changed_since_solve = true`" comparison; if Sadran-only, accept it only when `can_manage_week()` (members have no other write path).
- [ ] If validated (range, dependency on `trip_shape`/`one_way_car_mode`, etc. — e.g. `one_way_car_mode` is required only when `trip_shape <> 'round_trip'`, the enum-backed field pattern to follow for a new enum column): `check` constraint, mirrored in zod and in `submit_request`'s warning/validation block.
- [ ] Views: `create or replace view v_my_requests` / `v_board_rides` including the column (`security_invoker = true` stays).
- [ ] Other RPCs copying request fields (`materialize_templates`, `apply_solver_result` if it copies request fields): extend the mapping.
- [ ] RLS: adding a column changes no policy. Confirm: `supabase db diff` shows no policy changes.
- [ ] `npm run db:reset && npm run db:types`; commit `src/integrations/supabase/types.ts`.

### 2. TS enums (only if enum)
- [ ] `src/lib/enums.ts`: const array + zod + `assertSameEnum`; `he.enums.<enumName>` labels.

### 3. Schema, API, form (`src/features/requests/`)
- [ ] `schema.ts`: add to the request zod schema; defaults match SQL; refinements for cross-field rules.
- [ ] `api.ts`: map form ↔ column in create/update and in `toFormValues` (via `Tables<'requests'>` types).
- [ ] `components/RequestForm.tsx`: add the control in the right group (destination / times / passengers / flexibility / notes). shadcn `FormField`, labels via `useT()`, full width, 44px tap targets.
- [ ] Sadran-only: render in the board's request drawer (`src/features/board/components/RequestDrawer.tsx`) guarded by `useRole().isSadranFor(dept, weekStart)`, not in the member form.
- [ ] Repeat-weekly template form (`src/features/requests/components/TemplateForm.tsx`, if it exists): same control.

### 4. i18n (`src/i18n/he.ts`)
- [ ] `he.requests.fields.<field>.label` (+ `.help`, `.placeholder`); enum labels under `he.enums`.
- [ ] If shown in proposal WhatsApp text: add a placeholder to the `whatsapp` rows of `notification_templates` (seed + data migration) and pass it from the composer's vars (`src/lib/whatsapp.ts` only builds the `wa.me` URL; the Hebrew lives in the DB rows).

### 5. Solver input (only if the solver uses it)
- [ ] `src/solver/types.ts` `Request`: add the field (plain type, no DB import).
- [ ] `src/solver/normalize.ts`: default/derive it on `NormalizedRequest`.
- [ ] Use it in the relevant module (`seats.ts`, `merge.ts`, `assign.ts` `canPlace`, a rule in `rules/`, or `suggest.ts`).
- [ ] DB→solver mapper in `src/features/board/solverInput.ts` (and `supabase/functions/_shared` mapper if the edge `solve`/`on-ride-cancelled` functions build inputs).
- [ ] `src/solver/__fixtures__/gen.ts`: default for the new field so golden fixtures still load.

### 6. Display
- [ ] `src/features/requests/components/RequestCard.tsx` (my requests) if meaningful to the member.
- [ ] Board: `RequestDrawer.tsx`, unmet list row, ride tooltip (e.g. an icon like luggage).
- [ ] `src/features/siddur/` published view if it affects how a ride is described.

### 7. Tests
- [ ] `src/features/requests/schema.test.ts`: valid/invalid values, default, refinements.
- [ ] `src/features/board/solverInput.test.ts`: mapping set/null (if step 5).
- [ ] Solver tests for the behavior change (if step 5), in `src/solver/__tests__/`.
- [ ] `e2e/submit-request.spec.ts`: fill the field, assert it on the card (if member-visible).

### 8. Docs
- [ ] `docs/REQUIREMENTS.md` §5.1 fields table (Field, Required, Notes); §5.3 if validation changed.
- [ ] `docs/DATA_MODEL.md` `requests` and `request_templates` tables; enum §2 if applicable; §6 view definitions if changed.
- [ ] `docs/UX_FLOWS.md` §3.4 New / edit request: control placement and Hebrew label; §3.3 / §4.2 if shown on the my-week card or board; §10 i18n keys table.
- [ ] `docs/SOLVER.md` §1.1 / §2 `Request` type if the solver reads it.

## Final verification
- [ ] `npm run lint && npm run typecheck && npm run test` pass; `npm run db:reset` passes from scratch.
- [ ] `grep -rn "<field>" src supabase docs` covers: migration (column + `submit_request`), types.ts, schema.ts, api.ts, RequestForm, he.ts, card/drawer, REQUIREMENTS §5.1, DATA_MODEL (`requests` + `request_templates` + §3.6 write path).
- [ ] RLS unchanged (`supabase db diff` — column/view/function changes only).
- [ ] No Hebrew literal outside the allowed places (`grep -rnP "[\x{0590}-\x{05FF}]" src --include=*.ts --include=*.tsx | grep -v "src/i18n/he.ts\|src/solver/reasons.ts"` is empty).
- [ ] Manual: create a request with the field, edit it after the window closed (flag `changed_since_solve` if solve-relevant), see it on the board drawer.
