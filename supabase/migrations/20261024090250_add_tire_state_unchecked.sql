-- REQ §13.124: a tire the member did not check is logged as "unchecked", not "ok".
alter type public.tire_state add value if not exists 'unchecked';
