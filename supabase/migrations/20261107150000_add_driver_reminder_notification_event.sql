-- REQ §13.191 (TODO DR1): "leave in 30 minutes" reminder to a driver of someone else's ride. Alone in its file.
alter type public.notification_event add value if not exists 'driver_reminder';
