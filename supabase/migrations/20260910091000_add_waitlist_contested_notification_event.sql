-- Contested waiting-list groups (owner decision 2026-09-10): when several members need a
-- car at overlapping times on a published day and they cannot all be served, everyone in
-- the overlap is told at once instead of the first submitter silently winning.
-- `alter type ... add value` must be alone in its own file (the new value is not usable
-- inside the transaction that adds it).
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §2; ARCHITECTURE.md §9; UX_FLOWS.md §6.1.
alter type public.notification_event add value 'waitlist_contested';
