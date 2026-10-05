-- Three member-facing trip types (REQ §13.93, docs/ORIGINS_PLAN_2026-10.md §2 item 1).
-- `alter type … add value` always alone in its own file (CLAUDE.md Conventions); this is a
-- fresh `create type`, so it is fine alongside nothing else in this file (one concern).
create type public.trip_type as enum ('round_trip', 'one_way', 'drop_off');
