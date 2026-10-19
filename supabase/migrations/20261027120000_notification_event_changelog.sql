-- REQ §13.139: "מה חדש" — a release's changelog lands in the inbox as an unread message, never a push.
-- Its metadata row and `deliver_changelog()` are in 20261027120100_deliver_changelog.sql (an enum value is added alone).

alter type public.notification_event add value 'changelog';
