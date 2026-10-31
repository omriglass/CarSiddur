-- REQ §13.169 (c): the riders of a request edited by someone else are told what changed.
-- `alter type ... add value` stays alone in its file.
alter type public.notification_event add value 'ride_edited';
