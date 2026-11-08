-- REQ §13.202: a member named as an editor of another member's rides gets one inbox message.
alter type public.notification_event add value 'ride_editor_added';
