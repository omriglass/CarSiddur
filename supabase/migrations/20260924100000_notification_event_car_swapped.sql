-- REQ §13.92 (owner 2026-09-24, S1/A5) — swapping cars on a day gets its own notification
-- event instead of reusing `outcome_changed`, so members can mute it separately.
-- `alter type ... add value` must be alone in its own file (unusable in the same
-- transaction that adds it) — the emitter lives in 20260924100100_day_car_swap_rpcs.sql.
-- UX_FLOWS.md §6.1 canonical list grows to 26 events.
alter type public.notification_event add value 'car_swapped';
