-- REQ §13.112 (a): "drop points" -- places a member may name in plan B (a הקפצה to a junction/station the
-- kibbutz can reach even when no car goes the whole way). A per-place flag the admin sets in the destinations
-- page ("נקודת הקפצה"); production data is marked by the owner by hand, so there is no default seed here.
-- `destinations` is department-scoped (not part of the cross-department pin list of rls_smoke TEST 18).
alter table public.destinations add column is_drop_point boolean not null default false;
