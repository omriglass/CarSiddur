-- O3 (REQ §13.93, ORIGINS_PLAN §3/§4; SOLVER.md §3.15): a new proposal type for the solver's
-- `changeOrigin` suggestion -- "a car is free for the whole requested window at another place"
-- (payload `{ origin_id, car_id }`). `alter type … add value` alone in its own file
-- (CLAUDE.md Conventions).
alter type public.proposal_type add value 'origin';
