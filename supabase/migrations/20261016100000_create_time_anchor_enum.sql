-- REQ §13.110 (b): which way a request end was entered. `time_anchor` = what the member typed:
-- outbound `leave` (leave home at, default) / `arrive` (be there by); return `arrive` (be home by,
-- default) / `leave` (leave there at). DATA_MODEL §2.
create type public.time_anchor as enum ('leave', 'arrive');
