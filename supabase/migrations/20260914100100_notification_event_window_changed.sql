-- F2 (docs/TODO.md, owner answers A2-A4, 2026-09-14): a Sadran may change a week's
-- request-closing time (shorten or extend it, within [open_at, publish_at]). Members are
-- notified of the new deadline (owner A2). `alter type ... add value` must be alone in its
-- own file (never usable inside the same transaction that adds it) — the RPC that emits
-- this event lives in 20260914100200_set_week_close_at.sql, which runs after this one.
-- REQ §13.81; DATA_MODEL.md §2; ARCHITECTURE.md §9; UX_FLOWS.md §6.1 (25th canonical event).
alter type public.notification_event add value 'window_changed';
