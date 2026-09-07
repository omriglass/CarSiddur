// src/features/sadran/solverRun.ts
//
// Compatibility re-export: the solve/apply orchestration logic that used to
// live in this file has moved to `./applySolve` (bug-fix pass after owner
// testing, docs/UX_FLOWS.md §19 "Solve/apply semantics after owner
// testing") so the fix to the "rides disappearing" bug and its extensive
// documentation sit together in one file. Kept as a thin shim rather than
// deleted so every existing `from "../../solverRun"` / `from "./solverRun"`
// import elsewhere in `src/features/sadran/**` keeps working unchanged.
export * from "./applySolve";
