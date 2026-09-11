---
name: add-priority-rule
description: Add a new priority-policy rule type to the solver (e.g. "seniority", "household size"). Use when asked to "add a priority rule", "add a rule type", "new policy rule", "the solver should also prefer X", "give a boost to members who Y", or to change how requests are ranked. Covers the solver rule file, registry, SQL known-set, admin param form, i18n, tests and docs.
---

# Add a priority rule type

A rule type is a pure function giving each request a raw value that the engine normalizes to `0..1` and multiplies by the admin-chosen weight (`docs/SOLVER.md` §4). You add a **type**; admins add weights in the policy editor. Policies are data (`policy_versions.rules` jsonb), so no existing policy changes.

Reference: `docs/SOLVER.md` §4.1 (interface), §4.3 (shipped types), §4.5 (this procedure). Paths are the documented layout — if one differs in the repo, fix it here too.

## Inputs to collect before starting

- `type`: camelCase, stable forever (e.g. `seniority`). Matches shipped style (`rideType`, `peopleServed`).
- Params (1–3) with defaults and bounds, e.g. `{ fullCreditYears: number }`.
- `normalization`: `'unit'` if `score` already returns `0..1`; `'minmax'` if it is batch-relative.
- Hebrew one-liner for `describe(params)` (admin UI; goes into `src/solver/reasons.ts` as `RULE_<TYPE>_DESC`, never into the rule file) and Hebrew label/param labels for the editor (`he.ts`).
- Data the rule reads: `request`, `ctx.destinations`, `ctx.stats`, `ctx.batch`, `ctx.policy`. If it needs data not in `RuleContext` (e.g. member seniority), step 1c applies — the solver never fetches.

## Steps

### 1. Solver (`src/solver/`, pure)
- [ ] a. Create `src/solver/rules/<type>.ts`:
  ```ts
  import type { Rule, RuleContext } from './types';
  import type { NormalizedRequest } from '../slots';
  import { ruleDescription, PolicyParamsError } from '../reasons';   // the only Hebrew source in src/solver

  export interface <Type>Params { /* ... */ }

  export const <type>: Rule<<Type>Params> = {
    type: '<type>',
    normalization: 'unit',
    defaultParams: { /* ... */ },
    validateParams(raw) { /* return typed params or throw new PolicyParamsError('RULE_<TYPE>_BAD_PARAMS', {...}) */ },
    describe(p) { return ruleDescription('RULE_<TYPE>_DESC', p); },
    score(ctx: RuleContext<<Type>Params>, r: NormalizedRequest) { /* deterministic, no I/O */ },
  };
  ```
  Add `RULE_<TYPE>_DESC` (and the param-error template) to `src/solver/reasons.ts` — the rule file itself contains no Hebrew (CLAUDE.md hard rule 3).
- [ ] b. Register: add `<type>` to `ruleRegistry` in `src/solver/rules/index.ts`. `RuleType` widens automatically; the engine, sort and breakdown pick it up.
- [ ] c. Only if new input data is needed: extend `SolverStats` (per-member data) or `Request`/`Destination` in `src/solver/types.ts`, give it a default where `NormalizedRequest` is built (`slots.ts`), and extend the caller's loader in `src/features/solverBridge/buildSolverInput.ts` (grep `SolverInput`) — typically a SQL function like `fairness_stats()` exposed to Sadran/admin only (DATA_MODEL §7.3 pattern).
- [ ] d. New reason code? Add to `src/solver/reasons.ts` (Hebrew template) and list it in SOLVER.md §3.13.

### 2. Database
- [ ] Migration `YYYYMMDDHHMMSS_add_<type>_rule_type.sql`: `create or replace function public.validate_policy_rules(...)` with `'<type>'` added to the known-type array (copy the current body from the latest migration that defines it; DATA_MODEL §3.4 / `20260907090500_policies.sql`). No SQL enum exists for rule types.
- [ ] `supabase/seed.sql`: optionally add `{ "type": "<type>", "weight": 0, "params": {...} }` to the seeded default policy version so it shows in the editor (weight 0 = neutral). Never touch production policies; admins add it via the UI (creates a new `policy_versions` row).
- [ ] `npm run db:reset` passes.

### 3. Admin policy editor (`src/features/admin/policy/`)
- [ ] The editor lists `Object.keys(ruleRegistry)`, shows `describe(params)` and seeds `defaultParams` — no change for the list itself.
- [ ] RuleParamsEditor.tsx (in `src/features/admin/policy/components/`) handles rendering params via the rule's `describe/defaultParams/validateParams`; no separate param-form files per rule. Validation calls `ruleRegistry[type].validateParams` — no second schema.
- [ ] i18n (`src/i18n/he.ts` and `src/i18n/he.admin.ts`): `he.admin.policies.rules.<type>.label` and `.params.<param>`; `he.admin.policies.rules` is `Record<RuleType, ...>`.

### 4. Tests (`src/solver/rules/__tests__/<type>.test.ts`, Vitest — SOLVER.md §4.5, §7.1)
- [ ] Value range: min case → 0 (or batch min), max case → 1; clamped on extremes.
- [ ] `validateParams`: accepts `defaultParams`; rejects a malformed object with `PolicyParamsError`.
- [ ] Ordering: a 2-request/1-car fixture where raising this rule's weight flips who is served (greedy order changes).
- [ ] Determinism: same input twice → identical value.
- [ ] Registry test: there is no `registry.test.ts` yet — create `src/solver/rules/__tests__/registry.test.ts` asserting every `ruleRegistry` entry has `type === key`, or add the assertion to an existing rules test if one already covers the whole registry; do not duplicate.
- [ ] If step 1c changed `SolverStats`/`Request`: update `__fixtures__/gen.ts` and re-generate golden `*.expected.json` only if outputs legitimately changed (review the diff; do not blindly overwrite).

### 5. Docs
- [ ] `docs/SOLVER.md` §4.3 table: `type`, params, raw value definition (what gives 0/1, unknown data → ?). §4.4 example only if the owner wants it in the default policy.
- [ ] `docs/REQUIREMENTS.md` §7.2 table: one plain-language row (rule type, parameters, meaning).
- [ ] `docs/DATA_MODEL.md` §3.4: known-set note if it enumerates types; §7 if you added a stats function.
- [ ] `docs/UX_FLOWS.md` §5.8 Priority policy editor: only if the param form introduces a new control kind; §10 i18n keys table for the new `he.admin.policies.rules.<type>` keys.

## Final verification
- [ ] `npm run lint && npm run typecheck && npm run test` pass; `npm run db:reset` passes.
- [ ] `grep -rn "<type>" src supabase docs` hits: rule file, `rules/index.ts`, test, migration (`validate_policy_rules`), param form + its index, `he.ts`, SOLVER.md §4.3, REQUIREMENTS §7.2.
- [ ] `src/solver/rules/<type>.ts` imports only from `src/solver/**`.
- [ ] Hebrew appears only in `src/solver/reasons.ts` (reason templates, `RULE_<TYPE>_DESC`, param-error messages) and `src/i18n/he.ts`; `grep -rnP "[\x{0590}-\x{05FF}]" src/solver | grep -v reasons.ts` is empty.
- [ ] Manual: Admin → Policies → add rule → new type listed with its description; save creates a new version; solver preview breakdown shows the rule's contribution.
