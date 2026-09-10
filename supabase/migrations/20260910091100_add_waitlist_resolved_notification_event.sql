-- Contested waiting-list groups: the second of the two new events — the group was settled
-- (by a participant or by the Sadran) or cancelled. Alone in its own file, as required for
-- `alter type ... add value`.
-- REQ §7.3 / §13 (waiting list); DATA_MODEL.md §2; ARCHITECTURE.md §9; UX_FLOWS.md §6.1.
alter type public.notification_event add value 'waitlist_resolved';
