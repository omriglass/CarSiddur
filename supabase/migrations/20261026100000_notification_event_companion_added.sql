-- REQ §13.135 (owner 2026-10-16) — a member named as a companion on someone else's request gets
-- a notice. `alter type ... add value` stays alone in its file; meta row, copy and the emitter
-- trigger are in 20261026100100_companion_added_emitter.sql. UX_FLOWS §6.1 grows to 28 events.
alter type public.notification_event add value 'companion_added';
