-- Car care portal (owner decisions 2026-09-09): one new notification_event for issue
-- reports, tire fills and washes raised to a car's responsible person (or, absent one,
-- the department admins). `alter type ... add value` must be alone in its own file
-- (the new value is not usable inside the transaction that adds it).
-- REQ §6 (new subsection, car care); DATA_MODEL.md §2; ARCHITECTURE.md §9.
alter type public.notification_event add value 'car_care';
