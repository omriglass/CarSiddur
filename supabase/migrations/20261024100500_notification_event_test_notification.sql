-- Owner 2026-10-11 (REQ §13.125 f): a member sends themselves a test notification from the profile, to check that
-- notifications reach their devices. `alter type ... add value` must be alone in its file; the event's meta row, its
-- templates and `send_test_notification()` are in 20261024100600_send_test_notification.sql.
-- UX_FLOWS.md §6.1 canonical list grows to 27 events.
alter type public.notification_event add value 'test_notification';
