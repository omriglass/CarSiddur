-- REQ §13.77 (extended) — a multi-day series request may reach a week beyond the
-- department's normal opening horizon (department_settings.weeks_open_ahead). Such a week
-- needs a `weeks` row to exist at all (composite FK target for requests/rides, pinned
-- SERIES_CARRY_OVER rides) well before it would normally open. `upcoming` is that row's
-- phase: it is not open for ordinary (non-series) requests, not visible to members
-- (is_week_public() excludes it, unchanged), and is promoted to `open` automatically at its
-- normal opening time by materialize_department_weeks()/advance_week_phases()
-- (20260910095100_promote_upcoming_weeks_to_open.sql). alter type ... add value alone in
-- its own file/transaction — DATA_MODEL §0.
alter type public.week_phase add value 'upcoming' before 'open';
