-- REQ item 227 (d): owners of a private car are told about other people's changes on it.
alter type public.notification_event add value if not exists 'private_car_changed';
