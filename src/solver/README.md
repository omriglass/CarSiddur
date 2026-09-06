# src/solver

Pure TypeScript scheduling solver for the weekly siddur. No DOM, React,
Supabase, `Date.now()`, `new Date()`, or `Math.random()` anywhere in this
package (enforced by `__tests__/purity.test.ts`) — it runs unchanged in the
browser and in a Supabase edge function.

## API

```ts
import { solve, matchFreedSlot, tryAutoApprove, fits, ruleRegistry } from '@/solver';
const output = solve(input); // SolverInput -> SolverOutput, deterministic
```

`solve()` normalizes (`slots.ts`), pairs relay legs (`relay.ts`), scores
(`policy/engine.ts` + `rules/`), places with ordered greedy (`greedy.ts`),
improves within a budget (`improve.ts`), generates suggestions for what's
unmet (`suggestions.ts`, `merge.ts`, `splitLegs.ts`), asserts every hard
constraint (`invariants.ts`), and returns a value; persistence is the
caller's job. `live.ts` covers the two post-publish helpers.

## Purity rule

Every function here is pure. Hebrew lives only in `reasons.ts`, keyed by
`reasonCode`. Time is slot arithmetic off `week.startMs` and caller-supplied
`DayBounds` — never wall-clock or timezone-aware.

## Adding a priority rule type

See `.claude/skills/add-priority-rule` and `docs/SOLVER.md` §4.5: add
`rules/<type>.ts` (no Hebrew — call `ruleDescription()`), one line in
`rules/index.ts`, a description in `reasons.ts`, a test in
`rules/__tests__/<type>.test.ts`.
