-- REQ §13.110 (b): when the car's departure / return time later moves (classic form, Sadran shift,
-- a move), the entered time moves by the same amount. A statement that changes the entered time
-- itself wins (the sentence form sends depart_at and arrive_by together; submit_request sets
-- app.request_anchors_explicit while it writes them). When return_at becomes null (switched to
-- one-way) leave_dest_at is left alone - switching trip type never deletes information (REQ §13.97).
create or replace function public.requests_shift_anchors() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  v_shifted timestamptz;
begin
  if coalesce(current_setting('app.request_anchors_explicit', true), 'off') = 'on' then
    return new;
  end if;

  if old.depart_at is not null and new.depart_at is not null and new.depart_at <> old.depart_at
     and new.arrive_by is not null and new.arrive_by is not distinct from old.arrive_by then
    v_shifted := new.arrive_by + (new.depart_at - old.depart_at);
    if not public.is_quarter_hour(v_shifted) then
      v_shifted := to_timestamp(round(extract(epoch from v_shifted) / 900) * 900);
    end if;
    new.arrive_by := v_shifted;
  end if;

  if old.return_at is not null and new.return_at is not null and new.return_at <> old.return_at
     and new.leave_dest_at is not null and new.leave_dest_at is not distinct from old.leave_dest_at then
    v_shifted := new.leave_dest_at + (new.return_at - old.return_at);
    if not public.is_quarter_hour(v_shifted) then
      v_shifted := to_timestamp(round(extract(epoch from v_shifted) / 900) * 900);
    end if;
    new.leave_dest_at := v_shifted;
  end if;
  return new;
end $$;
alter function public.requests_shift_anchors() owner to postgres;
revoke all on function public.requests_shift_anchors() from public, anon, authenticated;

-- BEFORE UPDATE triggers fire alphabetically; this one only touches arrive_by / leave_dest_at, which no
-- other requests trigger reads (bump_version, requests_status_guard, requests_within_week, set_updated_at).
create trigger requests_shift_anchors before update of depart_at, return_at on public.requests
  for each row execute function public.requests_shift_anchors();
