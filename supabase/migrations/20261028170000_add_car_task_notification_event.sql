-- REQ item 150 (b): a quiet reminder before a ride listing the car tasks the person's ride carries.
-- `alter type ... add value` stays alone in its file.
alter type public.notification_event add value 'car_task';
